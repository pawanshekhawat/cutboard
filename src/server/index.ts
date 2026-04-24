#!/usr/bin/env node

import Fastify from 'fastify';
import { join, resolve, dirname, basename, extname, relative } from 'path';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, createWriteStream, unlinkSync } from 'fs';
import chokidar from 'chokidar';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { spawnSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { createHash } from 'crypto';
import type { CompositionAsset, EasingType, Project } from '../types/schema.js';
import { render } from '../engine/render.js';
import { loadProject, resolveProjectRootFromSrc, computeDuration } from '../engine/project.js';
import { upsertAnimationKeyframe } from '../shared/animation-model.js';
import { normalizeProjectContract } from '../shared/project-contract.js';
import { pipeline } from 'stream/promises';

const FFMPEG = ffmpegStatic as unknown as string;
const PROJECT_ROOT = resolve(process.env.CUTBOARD_PROJECT_ROOT || process.cwd());
const PROJECT_PATH = resolve(process.env.CUTBOARD_PROJECT_PATH || join(PROJECT_ROOT, 'project.json'));
const ASSETS_PATH = resolve(process.env.CUTBOARD_ASSETS_PATH || join(PROJECT_ROOT, 'assets'));
const SERVER_PORT = Number(process.env.CUTBOARD_PORT || 3001);
const FFPROBE = ffprobeStatic.path;
const CORS_ORIGINS = (process.env.CUTBOARD_CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const server = Fastify({ logger: true });

// Store connected SSE clients
const sseClients = new Set<any>();

// Enable CORS for studio app
server.register(cors, {
  origin: CORS_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});
server.register(multipart);

// Serve assets
server.register(fastifyStatic, {
  root: ASSETS_PATH,
  prefix: '/assets/',
  prefixAvoidTrailingSlash: true
});

// Health check
server.get('/', async () => {
  return {
    status: 'ok',
    service: 'CutBoard API',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  };
});

// SSE stream for real-time updates
server.get('/api/stream', (req, reply) => {
  reply.headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const client = reply.raw;
  sseClients.add(client);

  // Send initial connection event
  client.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Keep-alive ping to prevent proxies/servers from closing idle SSE connections
  const keepAlive = setInterval(() => {
    try {
      // SSE comment line (ignored by EventSource)
      client.write(':\n\n');
    } catch {
      // ignore
    }
  }, 15000);

  // Cleanup on client disconnect
  req.raw.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
    server.log.info('SSE client disconnected');
  });
});

// Broadcast update to all SSE clients
function broadcastUpdate() {
  const message = `data: ${JSON.stringify({ type: 'update', timestamp: Date.now() })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (err) {
      // Client disconnected, will be cleaned up
      sseClients.delete(client);
    }
  });
}

type Keyframe = { time: number; value: number };
type Animation = { target: string; property: string; keyframes: Keyframe[] };

function buildAnimationExpr(keyframes: Keyframe[]): string | null {
  if (!keyframes || keyframes.length < 2) return null;
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const k1 = sorted[0];
  const k2 = sorted[sorted.length - 1];
  const dt = k2.time - k1.time;
  if (dt === 0) return String(k2.value);
  const slope = (k2.value - k1.value) / dt;
  const intercept = k1.value - slope * k1.time;
  return `${slope}*t+${intercept}`;
}

function getAnimatedValue(
  elementId: string,
  propName: string,
  animations: Record<string, Animation> | undefined,
  defaultValue: number
): string {
  if (!animations) return String(defaultValue);
  const relevant = Object.values(animations).filter(a => a.target === elementId && a.property === propName);
  if (relevant.length === 0) return String(defaultValue);
  const allKeyframes = relevant.flatMap(a => a.keyframes || []);
  if (allKeyframes.length < 2) return String(defaultValue);
  return buildAnimationExpr(allKeyframes) ?? String(defaultValue);
}

type TLEntry = { id: string; src: string; start: number; end: number; trimStart: number };

function safeMtimeMs(absPath: string): number {
  try {
    if (!existsSync(absPath)) return 0;
    const st = statSync(absPath);
    return st.mtimeMs || 0;
  } catch {
    return 0;
  }
}

function listProjectDependencyPaths(project: Project, projectRoot: string): string[] {
  const deps: string[] = [resolve(projectRoot, 'project.json')];

  for (const asset of Object.values(project.assets || {})) {
    if (!asset?.src) continue;
    const abs = resolve(projectRoot, asset.src);
    deps.push(abs);

    if (asset.type === 'composition') {
      const childRoot = resolveProjectRootFromSrc(projectRoot, asset.src);
      deps.push(resolve(childRoot, 'project.json'));
    }
  }

  return deps;
}

function computeCompositionCacheKey(childRoot: string): string {
  const projectJson = resolve(childRoot, 'project.json');
  const child = loadProject(childRoot);

  const computedDuration = computeDuration(child.elements);
  if (!child.meta.duration || child.meta.duration < computedDuration) {
    child.meta.duration = computedDuration;
  }

  const deps = listProjectDependencyPaths(child, childRoot);
  const mtimes = deps
    .map(p => `${p}:${safeMtimeMs(p)}`)
    .sort()
    .join('\n');

  const h = createHash('sha1');
  h.update(readFileSync(projectJson, 'utf-8'));
  h.update('\n');
  h.update(JSON.stringify(child.meta));
  h.update('\n');
  h.update(mtimes);
  return h.digest('hex').slice(0, 24);
}

function resolveCompositionToCachedVideo(parentRoot: string, asset: CompositionAsset, cacheRootAbs: string): string {
  const childRoot = resolveProjectRootFromSrc(parentRoot, asset.src);
  const childProjectJson = resolve(childRoot, 'project.json');
  if (!existsSync(childProjectJson)) {
    throw new Error(`Composition asset missing child project.json at ${childProjectJson}`);
  }

  const key = computeCompositionCacheKey(childRoot);
  const outAbs = resolve(cacheRootAbs, `${childRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0]}-${key}.mp4`);
  mkdirSync(cacheRootAbs, { recursive: true });

  if (existsSync(outAbs)) return outAbs;

  const childProject = loadProject(childRoot);
  const computedDuration = computeDuration(childProject.elements);
  if (!childProject.meta.duration || childProject.meta.duration < computedDuration) {
    childProject.meta.duration = computedDuration;
  }

  // Renders into the deterministic cache file path.
  render(childProject, outAbs, childRoot);
  return outAbs;
}

function buildTimeline(project: any, root: string, compositionCacheRootAbs: string): TLEntry[] {
  const entries: TLEntry[] = [];
  for (const [id, el] of Object.entries(project.elements || {})) {
    const e = el as any;
    if (e.type !== 'video' && e.type !== 'composition') continue;
    const asset = project.assets?.[e.assetId];
    if (!asset) continue;
    if (asset.type === 'video') {
      entries.push({
        id,
        src: asset.src,
        start: e.start,
        end: e.start + e.duration,
        trimStart: e.trimStart ?? 0,
      });
    } else if (asset.type === 'composition') {
      const cachedAbs = resolveCompositionToCachedVideo(root, asset as CompositionAsset, compositionCacheRootAbs);
      entries.push({
        id,
        src: cachedAbs,
        start: e.start,
        end: e.start + e.duration,
        trimStart: e.trimStart ?? 0,
      });
    }
  }
  return entries.sort((a, b) => a.start - b.start);
}

function normalizeTransform(t: any) {
  return {
    x: typeof t?.x === 'number' ? t.x : 0,
    y: typeof t?.y === 'number' ? t.y : 0,
    scale: typeof t?.scale === 'number' ? t.scale : 1,
    rotation: typeof t?.rotation === 'number' ? t.rotation : 0,
    opacity: typeof t?.opacity === 'number' ? t.opacity : 1,
  };
}

function getVideoEffectsFilter(project: any, elementId: string): string {
  const effects = Object.values(project.effects || {}).filter((fx: any) => fx?.target === elementId);
  if (effects.length === 0) return '';

  const chain: string[] = [];
  for (const fx of effects as any[]) {
    if (fx.type === 'blur') {
      const radius = Math.max(0, Math.min(50, Number(fx.value) || 0));
      chain.push(`boxblur=luma_radius=${radius}:luma_power=1`);
    } else if (fx.type === 'grayscale') {
      if ((Number(fx.value) || 0) > 0) chain.push('hue=s=0');
    }
  }
  return chain.length > 0 ? `,${chain.join(',')}` : '';
}

function resolveAudioSourcePath(projectRoot: string, src: string): string {
  if (src.startsWith('/assets/')) {
    const relativeAsset = src.replace(/^\/assets\//, '');
    return resolve(ASSETS_PATH, relativeAsset);
  }
  return resolve(projectRoot, src);
}

function buildWaveformCacheKey(absAudioPath: string, bins: number): string {
  const st = statSync(absAudioPath);
  const h = createHash('sha1');
  h.update(absAudioPath);
  h.update('\n');
  h.update(String(st.size || 0));
  h.update('\n');
  h.update(String(st.mtimeMs || 0));
  h.update('\n');
  h.update(String(bins));
  return h.digest('hex').slice(0, 24);
}

function extractNormalizedWaveformPeaks(absAudioPath: string, bins: number): number[] {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    absAudioPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '12000',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    'pipe:1',
  ];

  const proc = spawnSync(FFMPEG, args, {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (proc.status !== 0 || !proc.stdout) {
    const err = proc.stderr ? proc.stderr.toString('utf-8') : 'Unknown ffmpeg error';
    throw new Error(`Failed to extract waveform samples: ${err}`);
  }

  const pcm = proc.stdout;
  const sampleCount = Math.floor(pcm.length / 4);
  if (sampleCount <= 0) {
    return Array.from({ length: bins }, () => 0);
  }

  const peaks = Array.from({ length: bins }, () => 0);
  const samplesPerBin = sampleCount / bins;

  for (let i = 0; i < bins; i++) {
    const startSample = Math.floor(i * samplesPerBin);
    const endSample = Math.min(sampleCount, Math.floor((i + 1) * samplesPerBin));
    let peak = 0;
    for (let s = startSample; s < endSample; s++) {
      const v = Math.abs(pcm.readFloatLE(s * 4));
      if (v > peak) peak = v;
    }
    peaks[i] = peak;
  }

  const maxPeak = peaks.reduce((m, v) => (v > m ? v : m), 0);
  if (maxPeak <= 0) return peaks.map(() => 0);

  return peaks.map((v) => Math.min(1, v / maxPeak));
}

type UploadAssetType = 'video' | 'audio' | 'image';

function inferUploadAssetType(filename: string, mimetype: string): UploadAssetType | null {
  const ext = extname(filename || '').toLowerCase();
  const mt = (mimetype || '').toLowerCase();

  if (mt.startsWith('video/') || ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'].includes(ext)) return 'video';
  if (mt.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (mt.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image';
  return null;
}

function inferUploadExtension(filename: string, mimetype: string, type: UploadAssetType): string {
  const ext = extname(filename || '').toLowerCase();
  if (ext) return ext;
  const mt = (mimetype || '').toLowerCase();
  if (type === 'video') return mt.includes('quicktime') ? '.mov' : '.mp4';
  if (type === 'audio') return mt.includes('wav') ? '.wav' : '.mp3';
  if (type === 'image') return mt.includes('jpeg') ? '.jpg' : '.png';
  return '.bin';
}

function probeUploadedAsset(absPath: string, type: UploadAssetType): { duration?: number; width?: number; height?: number } {
  try {
    const out = spawnSync(
      FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', absPath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (out.status !== 0 || !out.stdout) return {};
    const data = JSON.parse(out.stdout);
    const videoStream = (data.streams || []).find((s: any) => s.codec_type === 'video');
    const audioStream = (data.streams || []).find((s: any) => s.codec_type === 'audio');
    const duration = Number.parseFloat(String(data.format?.duration || videoStream?.duration || audioStream?.duration || '0'));

    if (type === 'video') {
      return {
        duration: Number.isFinite(duration) ? duration : 0,
        width: typeof videoStream?.width === 'number' ? videoStream.width : undefined,
        height: typeof videoStream?.height === 'number' ? videoStream.height : undefined,
      };
    }
    if (type === 'audio') {
      return { duration: Number.isFinite(duration) ? duration : 0 };
    }
    if (type === 'image') {
      return {
        width: typeof videoStream?.width === 'number' ? videoStream.width : undefined,
        height: typeof videoStream?.height === 'number' ? videoStream.height : undefined,
      };
    }
    return {};
  } catch {
    return {};
  }
}

// Get project
server.get('/api/project', async (request, reply) => {
  const query = request.query as any;
  const projectPath = query.path || PROJECT_PATH;
  
  try {
    const data = readFileSync(projectPath, 'utf-8');
    const normalized = normalizeProjectContract(JSON.parse(data));
    if (normalized.changed) {
      writeFileSync(projectPath, JSON.stringify(normalized.project, null, 2));
      broadcastUpdate();
      server.log.info('Normalized project.json contract fields');
    }

    return normalized.project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Generate a single proxy preview frame at a given timeline time (seconds)
const getProjectFrameHandler = async (request: any, reply: any) => {
  const query = (request.query ?? {}) as any;
  const time = query.time;
  const projectPath = query.path || PROJECT_PATH;
  const tRaw = Number(time);
  const requestedTime = Number.isFinite(tRaw) ? Math.max(0, tRaw) : 0;

  try {
    const root = dirname(projectPath);
    const normalized = normalizeProjectContract(JSON.parse(readFileSync(projectPath, 'utf-8')));
    const project = normalized.project;
    const meta = project.meta || {};
    const duration = Math.max(Number(meta.duration) || 1, 1);
    const t = Math.min(requestedTime, duration);

    const compositionCacheRootAbs = resolve(root, 'output/.cache/compositions');
    const timeline = buildTimeline(project, root, compositionCacheRootAbs);
    const textEls = Object.values(project.elements || {}).filter((e: any) => e.type === 'text') as any[];

    const args: string[] = ['-hide_banner', '-loglevel', 'error', '-y'];
    let fc = '';

    if (timeline.length === 0) {
      args.push(
        '-f', 'lavfi',
        '-i',
        `color=c=black:s=${meta.resolution?.width || 1920}x${meta.resolution?.height || 1080}:d=${duration}`
      );

      const fl: string[] = [];
      let top = '[0:v]';

      for (let i = 0; i < textEls.length; i++) {
        const el = textEls[i];
        const tr = normalizeTransform(el.transform);
        const e = String(el.content || '')
          .replace(/'/g, "'\\''")
          .replace(/:/g, '\\:')
          .replace(/\n/g, '\\n');
        const xExpr = getAnimatedValue(el.id, 'transform.x', project.animations, tr.x);
        const yExpr = getAnimatedValue(el.id, 'transform.y', project.animations, tr.y);
        const en = `enable='between(t,${el.start},${el.start + el.duration})'`;
        const nxt = i === textEls.length - 1 ? '[out]' : `[t${i}]`;
        fl.push(`${top}drawtext=text='${e}':fontsize=${el.style?.fontSize ?? 48}:fontcolor=${el.style?.color ?? '#ffffff'}:x=${xExpr}:y=${yExpr}:${en}${nxt}`);
        top = nxt;
      }

      fc = fl.length > 0 ? fl.join('; ') : '[0:v]copy[out]';
    } else {
      const assetList: string[] = [];
      const assetIdx = new Map<string, number>();
      for (const e of timeline) {
        if (!assetIdx.has(e.src)) {
          assetIdx.set(e.src, assetList.length);
          assetList.push(e.src);
        }
      }
      for (const s of assetList) args.push('-i', resolve(root, s));

      const fl: string[] = [];
      fl.push(`color=c=black:size=${meta.resolution?.width || 1920}x${meta.resolution?.height || 1080}:rate=${meta.fps || 30}:duration=${duration}[base]`);

      for (let i = 0; i < timeline.length; i++) {
        const e = timeline[i];
        const ii = assetIdx.get(e.src)!;
        const clipDur = e.end - e.start;
        const fx = getVideoEffectsFilter(project, e.id);
        fl.push(
          `[${ii}:v]trim=start=${e.trimStart}:duration=${clipDur},setpts=PTS-STARTPTS+${e.start}/TB,` +
          `scale=${meta.resolution?.width || 1920}:${meta.resolution?.height || 1080}:force_original_aspect_ratio=decrease,setsar=1${fx}[v${i}]`
        );
      }

      let prev = '[base]';
      for (let i = 0; i < timeline.length; i++) {
        const e = timeline[i];
        const outL = i === timeline.length - 1 ? '[vout]' : `[tmp${i}]`;
        fl.push(`${prev}[v${i}]overlay=0:0:enable='between(t,${e.start},${e.end})'${outL}`);
        prev = outL;
      }

      let top = '[vout]';
      for (let i = 0; i < textEls.length; i++) {
        const el = textEls[i];
        const tr = normalizeTransform(el.transform);
        const e = String(el.content || '')
          .replace(/'/g, "'\\''")
          .replace(/:/g, '\\:')
          .replace(/\n/g, '\\n');
        const xExpr = getAnimatedValue(el.id, 'transform.x', project.animations, tr.x);
        const yExpr = getAnimatedValue(el.id, 'transform.y', project.animations, tr.y);
        const en = `enable='between(t,${el.start},${el.start + el.duration})'`;
        const nxt = i === textEls.length - 1 ? '[out]' : `[t${i}]`;
        fl.push(`${top}drawtext=text='${e}':fontsize=${el.style?.fontSize ?? 48}:fontcolor=${el.style?.color ?? '#ffffff'}:x=${xExpr}:y=${yExpr}:${en}${nxt}`);
        top = nxt;
      }

      fc = fl.join('; ');
    }

    args.push(
      '-filter_complex', fc,
      '-map', '[out]',
      '-ss', String(t),
      '-frames:v', '1',
      '-an',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    );

    const proc = spawnSync(FFMPEG, args, {
      encoding: null,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (proc.status !== 0 || !proc.stdout || proc.stdout.length === 0) {
      const err = proc.stderr ? proc.stderr.toString('utf-8') : 'Unknown ffmpeg error';
      return reply.status(500).send({ error: 'Failed to generate proxy frame', details: err });
    }

    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-store')
      .send(proc.stdout);
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
};

// Register both with and without trailing slash to avoid path normalization issues.
server.get('/api/project/frame', getProjectFrameHandler);
server.get('/api/project/frame/', getProjectFrameHandler);

server.get('/api/audio/waveform', async (request, reply) => {
  const query = (request.query ?? {}) as any;
  const projectPath = query.path || PROJECT_PATH;
  const assetId = typeof query.assetId === 'string' ? query.assetId : '';
  const explicitSrc = typeof query.src === 'string' ? query.src : '';
  const binsRaw = Number(query.samples);
  const bins = Number.isFinite(binsRaw) ? Math.max(32, Math.min(4096, Math.floor(binsRaw))) : 512;

  try {
    const root = dirname(projectPath);
    const project = normalizeProjectContract(JSON.parse(readFileSync(projectPath, 'utf-8'))).project as Project;

    let src = explicitSrc;
    if (!src && assetId) {
      const asset = project.assets?.[assetId];
      if (asset?.type !== 'audio') {
        return reply.status(404).send({ error: 'Audio asset not found' });
      }
      src = asset.src;
    }

    if (!src) {
      return reply.status(400).send({ error: 'Missing audio source. Provide assetId or src.' });
    }

    const absAudioPath = resolveAudioSourcePath(root, src);
    if (!existsSync(absAudioPath)) {
      return reply.status(404).send({ error: `Audio file not found: ${absAudioPath}` });
    }

    const cacheRoot = resolve(root, 'output/.cache/waveforms');
    mkdirSync(cacheRoot, { recursive: true });
    const cacheKey = buildWaveformCacheKey(absAudioPath, bins);
    const base = basename(absAudioPath, extname(absAudioPath)) || 'audio';
    const cachePath = resolve(cacheRoot, `${base}-${cacheKey}.json`);

    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as { peaks: number[] };
      return {
        peaks: cached.peaks,
        cached: true,
      };
    }

    const peaks = extractNormalizedWaveformPeaks(absAudioPath, bins);
    writeFileSync(cachePath, JSON.stringify({ peaks }));

    return {
      peaks,
      cached: false,
    };
  } catch (error: any) {
    return reply.status(500).send({ error: error?.message || 'Failed to build waveform' });
  }
});

server.post('/api/assets', async (request, reply) => {
  const part = await request.file();
  if (!part) {
    return reply.status(400).send({ error: 'Missing file upload. Use multipart/form-data with field "file".' });
  }

  const originalFilename = part.filename || 'upload.bin';
  const assetType = inferUploadAssetType(originalFilename, part.mimetype);
  if (!assetType) {
    return reply.status(400).send({ error: `Unsupported file type: ${originalFilename} (${part.mimetype || 'unknown'})` });
  }

  const projectPathField = part.fields?.projectPath;
  const projectPathValue = (() => {
    if (!projectPathField) return undefined;
    const field = Array.isArray(projectPathField) ? projectPathField[0] : projectPathField;
    const value = (field as any)?.value;
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  })();
  const projectPath = projectPathValue ? resolve(projectPathValue) : PROJECT_PATH;
  const projectRoot = dirname(projectPath);

  mkdirSync(ASSETS_PATH, { recursive: true });

  const ext = inferUploadExtension(originalFilename, part.mimetype, assetType);
  const uniqueBase = `${Date.now()}-${createHash('sha1').update(`${originalFilename}-${Math.random()}`).digest('hex').slice(0, 10)}`;
  const uniqueFilename = `${uniqueBase}${ext}`;
  const absOutputPath = resolve(ASSETS_PATH, uniqueFilename);

  try {
    await pipeline(part.file, createWriteStream(absOutputPath));

    const metadata = probeUploadedAsset(absOutputPath, assetType);

    const rel = relative(projectRoot, absOutputPath).replace(/\\/g, '/');
    const src = rel.startsWith('..') ? absOutputPath : rel;
    const assetId = src;

    const raw = JSON.parse(readFileSync(projectPath, 'utf-8'));
    const normalized = normalizeProjectContract(raw);
    const project = normalized.project;

    if (!project.assets || typeof project.assets !== 'object') project.assets = {};

    if (assetType === 'video') {
      project.assets[assetId] = {
        type: 'video',
        src,
        duration: typeof metadata.duration === 'number' ? metadata.duration : 0,
      };
    } else if (assetType === 'audio') {
      project.assets[assetId] = {
        type: 'audio',
        src,
      };
    } else {
      project.assets[assetId] = {
        type: 'image',
        src,
      };
    }

    const normalizedOut = normalizeProjectContract(project);
    writeFileSync(projectPath, JSON.stringify(normalizedOut.project, null, 2));
    broadcastUpdate();

    return {
      assetId,
      asset: normalizedOut.project.assets[assetId],
      metadata,
    };
  } catch (error: any) {
    if (existsSync(absOutputPath)) {
      try { unlinkSync(absOutputPath); } catch {}
    }
    return reply.status(500).send({ error: error?.message || 'Failed to upload asset' });
  }
});

// Update element
server.post('/api/project/element', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, updates } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = normalizeProjectContract(JSON.parse(data)).project;

    if (!project.elements[elementId]) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    project.elements[elementId] = {
      ...project.elements[elementId],
      ...updates
    };

    const normalized = normalizeProjectContract(project);

    writeFileSync(projectPath, JSON.stringify(normalized.project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated element ${elementId}`);
    
    return normalized.project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Update keyframe
server.post('/api/project/keyframe', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, keyframeIndex, keyframeId, value, time, easing } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = normalizeProjectContract(JSON.parse(data)).project;

    const animationExists = Object.values(project.animations || {}).some(
      (anim: any) => anim.target === elementId && anim.property === property
    );
    if (!animationExists) {
      return reply.status(404).send({ error: 'Animation not found' });
    }

    const resolvedTime = typeof time === 'number' ? time : Number.NaN;
    const resolvedValue = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(resolvedTime) || !Number.isFinite(resolvedValue)) {
      return reply.status(400).send({ error: 'Both numeric "time" and "value" are required' });
    }

    upsertAnimationKeyframe(project, {
      target: elementId,
      property,
      time: resolvedTime,
      value: resolvedValue,
      easing: (typeof easing === 'string' ? easing : 'easeInOut') as EasingType,
      keyframeId: typeof keyframeId === 'string' ? keyframeId : undefined,
      keyframeIndex: typeof keyframeIndex === 'number' ? keyframeIndex : undefined,
    });

    const normalized = normalizeProjectContract(project);
    writeFileSync(projectPath, JSON.stringify(normalized.project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated keyframe ${keyframeIndex} for ${property} on element ${elementId}`);
    
    return normalized.project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Add or update animation keyframe
server.post('/api/project/animation', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, time, value, easing = 'linear', keyframeId } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = normalizeProjectContract(JSON.parse(data)).project;

    const resolvedTime = Number(time);
    const resolvedValue = Number(value);
    if (!Number.isFinite(resolvedTime) || !Number.isFinite(resolvedValue)) {
      return reply.status(400).send({ error: 'Both numeric "time" and "value" are required' });
    }

    upsertAnimationKeyframe(project, {
      target: elementId,
      property,
      time: resolvedTime,
      value: resolvedValue,
      easing: easing as EasingType,
      keyframeId: typeof keyframeId === 'string' ? keyframeId : undefined,
    });

    const normalized = normalizeProjectContract(project);
    writeFileSync(projectPath, JSON.stringify(normalized.project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Added keyframe at t=${time}s for ${property} on element ${elementId}`);
    
    return normalized.project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Start server
const start = async () => {
  try {
    await server.listen({ port: SERVER_PORT });
    console.log(`🎬 CutBoard API Server running at http://localhost:${SERVER_PORT}`);
    console.log('📺 Studio app should be at http://localhost:5173');
    console.log(server.printRoutes());
    
    // Watch project file and broadcast changes
    const watcher = chokidar.watch(PROJECT_PATH, {
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('change', () => {
      server.log.info('project.json changed externally');
      broadcastUpdate();
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
