#!/usr/bin/env node

import Fastify from 'fastify';
import { join, resolve, dirname, basename, extname, relative } from 'path';
import { existsSync, statSync, mkdirSync, createWriteStream, unlinkSync } from 'fs';
import * as fsp from 'fs/promises';
import chokidar from 'chokidar';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { createHash } from 'crypto';
import type { CompositionAsset, EasingType, Project } from '../types/schema.js';
import { render } from '../engine/render.js';
import { resolveProjectRootFromSrc, computeDuration } from '../engine/project.js';
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
const FRAME_CACHE_TTL_MS = Number(process.env.CUTBOARD_FRAME_CACHE_TTL_MS || 15000);
const FRAME_CACHE_MAX_ITEMS = Number(process.env.CUTBOARD_FRAME_CACHE_MAX_ITEMS || 120);
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

const frameMemoryCache = new Map<string, { buffer: Buffer; expiresAt: number }>();
const frameJobs = new Map<string, Promise<Buffer>>();
const waveformMemoryCache = new Map<string, { peaks: number[]; expiresAt: number }>();
const waveformJobs = new Map<string, Promise<number[]>>();

function getMemoryCachedFrame(key: string): Buffer | null {
  const hit = frameMemoryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    frameMemoryCache.delete(key);
    return null;
  }
  return hit.buffer;
}

function putMemoryCachedFrame(key: string, buffer: Buffer) {
  frameMemoryCache.set(key, { buffer, expiresAt: Date.now() + FRAME_CACHE_TTL_MS });
  if (frameMemoryCache.size <= FRAME_CACHE_MAX_ITEMS) return;
  const oldest = frameMemoryCache.keys().next().value as string | undefined;
  if (oldest) frameMemoryCache.delete(oldest);
}

function getMemoryCachedWaveform(key: string): number[] | null {
  const hit = waveformMemoryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    waveformMemoryCache.delete(key);
    return null;
  }
  return hit.peaks;
}

function putMemoryCachedWaveform(key: string, peaks: number[]) {
  waveformMemoryCache.set(key, { peaks, expiresAt: Date.now() + 30000 });
  if (waveformMemoryCache.size <= 200) return;
  const oldest = waveformMemoryCache.keys().next().value as string | undefined;
  if (oldest) waveformMemoryCache.delete(oldest);
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function safeMtimeMsAsync(absPath: string): Promise<number> {
  try {
    const st = await fsp.stat(absPath);
    return st.mtimeMs || 0;
  } catch {
    return 0;
  }
}

async function runProcessToBuffer(
  command: string,
  args: string[],
  opts?: { maxBufferBytes?: number }
): Promise<{ status: number; stdout: Buffer; stderr: Buffer }> {
  const maxBufferBytes = opts?.maxBufferBytes ?? 128 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let rejected = false;

    const onChunk = (chunk: Buffer, target: Buffer[], lenRef: 'out' | 'err') => {
      if (rejected) return;
      const nextLen = (lenRef === 'out' ? outLen : errLen) + chunk.length;
      if (nextLen > maxBufferBytes) {
        rejected = true;
        child.kill('SIGKILL');
        reject(new Error(`Process output exceeded max buffer (${maxBufferBytes} bytes)`));
        return;
      }
      if (lenRef === 'out') outLen = nextLen;
      else errLen = nextLen;
      target.push(chunk);
    };

    child.stdout?.on('data', (d) => onChunk(Buffer.from(d), outChunks, 'out'));
    child.stderr?.on('data', (d) => onChunk(Buffer.from(d), errChunks, 'err'));
    child.on('error', (err) => {
      if (rejected) return;
      rejected = true;
      reject(err);
    });
    child.on('close', (code) => {
      if (rejected) return;
      resolvePromise({
        status: code ?? -1,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks),
      });
    });
  });
}

async function readProjectNormalized(projectPath: string): Promise<Project> {
  const raw = JSON.parse(await fsp.readFile(projectPath, 'utf-8'));
  return normalizeProjectContract(raw).project as Project;
}

async function writeProjectNormalized(projectPath: string, project: Project): Promise<Project> {
  const normalized = normalizeProjectContract(project);
  await fsp.writeFile(projectPath, JSON.stringify(normalized.project, null, 2), 'utf-8');
  return normalized.project as Project;
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

async function computeCompositionCacheKey(childRoot: string): Promise<string> {
  const projectJson = resolve(childRoot, 'project.json');
  const child = await readProjectNormalized(projectJson);

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
  h.update(await fsp.readFile(projectJson, 'utf-8'));
  h.update('\n');
  h.update(JSON.stringify(child.meta));
  h.update('\n');
  h.update(mtimes);
  return h.digest('hex').slice(0, 24);
}

async function resolveCompositionToCachedVideo(parentRoot: string, asset: CompositionAsset, cacheRootAbs: string): Promise<string> {
  const childRoot = resolveProjectRootFromSrc(parentRoot, asset.src);
  const childProjectJson = resolve(childRoot, 'project.json');
  if (!existsSync(childProjectJson)) {
    throw new Error(`Composition asset missing child project.json at ${childProjectJson}`);
  }

  const key = await computeCompositionCacheKey(childRoot);
  const outAbs = resolve(cacheRootAbs, `${childRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0]}-${key}.mp4`);
  mkdirSync(cacheRootAbs, { recursive: true });

  if (existsSync(outAbs)) return outAbs;

  const childProject = await readProjectNormalized(childProjectJson);
  const computedDuration = computeDuration(childProject.elements);
  if (!childProject.meta.duration || childProject.meta.duration < computedDuration) {
    childProject.meta.duration = computedDuration;
  }

  // Renders into the deterministic cache file path.
  render(childProject, outAbs, childRoot);
  return outAbs;
}

async function buildTimeline(project: any, root: string, compositionCacheRootAbs: string): Promise<TLEntry[]> {
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
      const cachedAbs = await resolveCompositionToCachedVideo(root, asset as CompositionAsset, compositionCacheRootAbs);
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

async function buildWaveformCacheKey(absAudioPath: string, bins: number): Promise<string> {
  const st = await fsp.stat(absAudioPath);
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

async function extractNormalizedWaveformPeaks(absAudioPath: string, bins: number): Promise<number[]> {
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

  const proc = await runProcessToBuffer(FFMPEG, args, { maxBufferBytes: 128 * 1024 * 1024 });
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

async function computeProjectFrameFingerprint(projectPath: string, project: Project, root: string): Promise<string> {
  const deps = listProjectDependencyPaths(project, root);
  if (!deps.includes(projectPath)) deps.push(projectPath);
  const mtimes = await Promise.all(
    deps
      .sort()
      .map(async (p) => `${p}:${await safeMtimeMsAsync(p)}`)
  );
  const h = createHash('sha1');
  h.update(JSON.stringify(project.meta));
  h.update('\n');
  h.update(JSON.stringify(project.animations || {}));
  h.update('\n');
  h.update(JSON.stringify(project.effects || {}));
  h.update('\n');
  h.update(mtimes.join('\n'));
  return h.digest('hex').slice(0, 24);
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

async function probeUploadedAsset(absPath: string, type: UploadAssetType): Promise<{ duration?: number; width?: number; height?: number }> {
  try {
    const out = await runProcessToBuffer(
      FFPROBE,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', absPath],
      { maxBufferBytes: 8 * 1024 * 1024 }
    );
    if (out.status !== 0 || !out.stdout) return {};
    const data = JSON.parse(out.stdout.toString('utf-8'));
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
    return await readProjectNormalized(projectPath);
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
    const project = await readProjectNormalized(projectPath);
    const meta = project.meta || {};
    const duration = Math.max(Number(meta.duration) || 1, 1);
    const t = Math.min(requestedTime, duration);
    const fps = Math.max(1, Number(meta.fps) || 30);
    const frameIndex = Math.max(0, Math.round(t * fps));
    const frameTime = frameIndex / fps;

    const compositionCacheRootAbs = resolve(root, 'output/.cache/compositions');
    const timeline = await buildTimeline(project, root, compositionCacheRootAbs);
    const textEls = Object.values(project.elements || {}).filter((e: any) => e.type === 'text') as any[];
    const fingerprint = await computeProjectFrameFingerprint(projectPath, project as Project, root);
    const frameKey = `${fingerprint}-${frameIndex}`;
    const memoryHit = getMemoryCachedFrame(frameKey);
    if (memoryHit) {
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=1')
        .send(memoryHit);
    }

    const frameCacheRootAbs = resolve(root, 'output/.cache/frames');
    await fsp.mkdir(frameCacheRootAbs, { recursive: true });
    const frameCachePath = resolve(frameCacheRootAbs, `${frameKey}.jpg`);

    const existingJob = frameJobs.get(frameKey);
    if (existingJob) {
      const shared = await existingJob;
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=1')
        .send(shared);
    }

    const job = (async (): Promise<Buffer> => {
      if (await fileExists(frameCachePath)) {
        const bytes = await fsp.readFile(frameCachePath);
        putMemoryCachedFrame(frameKey, bytes);
        return bytes;
      }

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
        '-ss', String(frameTime),
        '-frames:v', '1',
        '-an',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1'
      );

      const proc = await runProcessToBuffer(FFMPEG, args, { maxBufferBytes: 20 * 1024 * 1024 });
      if (proc.status !== 0 || !proc.stdout || proc.stdout.length === 0) {
        const err = proc.stderr ? proc.stderr.toString('utf-8') : 'Unknown ffmpeg error';
        throw new Error(`Failed to generate proxy frame: ${err}`);
      }
      await fsp.writeFile(frameCachePath, proc.stdout);
      putMemoryCachedFrame(frameKey, proc.stdout);
      return proc.stdout;
    })();

    frameJobs.set(frameKey, job);
    const bytes = await job.finally(() => {
      const inflight = frameJobs.get(frameKey);
      if (inflight === job) frameJobs.delete(frameKey);
    });

    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'private, max-age=1')
      .send(bytes);
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
  const emptyWaveform = { peaks: Array.from({ length: bins }, () => 0), cached: false };

  try {
    const root = dirname(projectPath);
    const project = await readProjectNormalized(projectPath) as Project;

    let src = explicitSrc;
    if (!src && assetId) {
      const asset = project.assets?.[assetId];
      if (asset?.type !== 'audio') {
        return reply.status(404).send({ error: 'Audio asset not found' });
      }
      src = asset.src;
    }

    if (!src) {
      return { ...emptyWaveform, error: 'Missing audio source. Provide assetId or src.' };
    }

    const absAudioPath = resolveAudioSourcePath(root, src);
    if (!(await fileExists(absAudioPath))) {
      return { ...emptyWaveform, error: `Audio file not found: ${absAudioPath}` };
    }

    const cacheRoot = resolve(root, 'output/.cache/waveforms');
    await fsp.mkdir(cacheRoot, { recursive: true });
    const cacheKey = await buildWaveformCacheKey(absAudioPath, bins);
    const base = basename(absAudioPath, extname(absAudioPath)) || 'audio';
    const cachePath = resolve(cacheRoot, `${base}-${cacheKey}.json`);
    const memKey = `${cachePath}:${bins}`;

    const memHit = getMemoryCachedWaveform(memKey);
    if (memHit) {
      return { peaks: memHit, cached: true };
    }

    if (await fileExists(cachePath)) {
      const cached = JSON.parse(await fsp.readFile(cachePath, 'utf-8')) as { peaks: number[] };
      putMemoryCachedWaveform(memKey, cached.peaks);
      return {
        peaks: cached.peaks,
        cached: true,
      };
    }

    const existingJob = waveformJobs.get(memKey);
    if (existingJob) {
      const peaks = await existingJob;
      return { peaks, cached: true };
    }

    const job = (async () => {
      const peaks = await extractNormalizedWaveformPeaks(absAudioPath, bins);
      await fsp.writeFile(cachePath, JSON.stringify({ peaks }));
      putMemoryCachedWaveform(memKey, peaks);
      return peaks;
    })();
    waveformJobs.set(memKey, job);
    const peaks = await job.finally(() => {
      const inflight = waveformJobs.get(memKey);
      if (inflight === job) waveformJobs.delete(memKey);
    });

    return {
      peaks,
      cached: false,
    };
  } catch (error: any) {
    return { ...emptyWaveform, error: error?.message || 'Failed to build waveform' };
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

    const metadata = await probeUploadedAsset(absOutputPath, assetType);

    const rel = relative(projectRoot, absOutputPath).replace(/\\/g, '/');
    const src = rel.startsWith('..') ? absOutputPath : rel;
    const assetId = src;

    const project = await readProjectNormalized(projectPath);

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

    const normalizedOut = await writeProjectNormalized(projectPath, project);
    broadcastUpdate();

    return {
      assetId,
      asset: normalizedOut.assets[assetId],
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
    const project = await readProjectNormalized(projectPath);

    if (!project.elements[elementId]) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    project.elements[elementId] = {
      ...project.elements[elementId],
      ...updates
    };

    const normalized = await writeProjectNormalized(projectPath, project);
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated element ${elementId}`);
    
    return normalized;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Append a new element and place it on a target track.
server.post('/api/project/elements', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, element, trackId } = body;

  try {
    if (!element || typeof element !== 'object') {
      return reply.status(400).send({ error: 'Missing "element" object payload' });
    }
    if (typeof trackId !== 'string' || trackId.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing required "trackId"' });
    }
    if (typeof element.id !== 'string' || element.id.trim().length === 0) {
      return reply.status(400).send({ error: 'Element must contain a non-empty string "id"' });
    }

    const project = await readProjectNormalized(projectPath);

    if (project.elements[element.id]) {
      return reply.status(409).send({ error: `Element id already exists: ${element.id}` });
    }

    let track = project.tracks.find((t) => t.id === trackId) as any | undefined;
    if (!track) {
      const inferredType = element?.type === 'audio' ? 'audio' : 'video';
      const created = {
        id: trackId,
        type: inferredType,
        elements: [],
      } as any;
      project.tracks.push(created);
      track = created;
    }

    project.elements[element.id] = element;
    if (!track.elements.includes(element.id)) track.elements.push(element.id);

    const normalized = await writeProjectNormalized(projectPath, project);

    broadcastUpdate();
    server.log.info(`Appended element ${element.id} to track ${trackId}`);
    return normalized;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Delete an element and remove it from any tracks.
server.delete('/api/project/elements/:elementId', async (request, reply) => {
  const params = (request.params ?? {}) as any;
  const query = (request.query ?? {}) as any;
  const body = (request.body ?? {}) as any;

  const elementId = typeof params.elementId === 'string' ? params.elementId : '';
  const projectPath =
    (typeof query.projectPath === 'string' && query.projectPath.trim().length > 0 ? query.projectPath : undefined) ||
    (typeof query.path === 'string' && query.path.trim().length > 0 ? query.path : undefined) ||
    (typeof body.projectPath === 'string' && body.projectPath.trim().length > 0 ? body.projectPath : undefined) ||
    PROJECT_PATH;

  try {
    if (!elementId) {
      return reply.status(400).send({ error: 'Missing elementId' });
    }

    const project = await readProjectNormalized(projectPath);
    if (!project.elements?.[elementId as any]) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    // Remove from elements dictionary
    delete (project.elements as any)[elementId];

    // Remove from tracks
    if (Array.isArray(project.tracks)) {
      for (const t of project.tracks as any[]) {
        if (!Array.isArray(t.elements)) continue;
        t.elements = t.elements.filter((id: any) => id !== elementId);
      }
      // Optional: drop empty tracks to keep the timeline tidy
      project.tracks = (project.tracks as any[]).filter((t) => Array.isArray(t.elements) && t.elements.length > 0) as any;
    }

    // Remove animations/effects targeting this element (best-effort; schema may vary)
    if (project.animations && typeof project.animations === 'object') {
      for (const [id, anim] of Object.entries(project.animations as any)) {
        if ((anim as any)?.target === elementId) delete (project.animations as any)[id];
      }
    }
    if ((project as any).effects && typeof (project as any).effects === 'object') {
      for (const [id, fx] of Object.entries((project as any).effects)) {
        if ((fx as any)?.target === elementId) delete (project as any).effects[id];
      }
    }

    // Recompute duration metadata (never shrink below 1s to keep UI sane)
    const computed = computeDuration(project.elements as any);
    project.meta.duration = Math.max(Number(project.meta.duration) || 1, computed || 0, 1);

    const normalized = await writeProjectNormalized(projectPath, project);
    broadcastUpdate();
    server.log.info(`Deleted element ${elementId}`);
    return normalized;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Reorder track layering (z-index order) by explicit track ID array.
server.put('/api/project/tracks/reorder', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, trackIds } = body;

  try {
    if (!Array.isArray(trackIds) || trackIds.some((id) => typeof id !== 'string')) {
      return reply.status(400).send({ error: '"trackIds" must be an array of strings' });
    }

    const project = await readProjectNormalized(projectPath);

    // Legacy projects may not have explicit tracks yet; bootstrap 1 track per element
    // using deterministic IDs so frontend can reorder immediately.
    if (!Array.isArray(project.tracks) || project.tracks.length === 0) {
      const elementIds = Object.keys(project.elements || {});
      project.tracks = elementIds.map((elementId) => {
        const el = (project.elements as any)?.[elementId];
        return {
          id: `track_${elementId}`,
          type: el?.type === 'audio' ? 'audio' : 'video',
          elements: [elementId],
        };
      }) as any;
    }

    const currentIds = project.tracks.map((t) => t.id);
    const uniqueRequested = new Set(trackIds);
    if (uniqueRequested.size !== trackIds.length) {
      return reply.status(400).send({ error: '"trackIds" contains duplicate values' });
    }
    if (trackIds.length !== currentIds.length) {
      return reply.status(400).send({ error: `"trackIds" length mismatch: expected ${currentIds.length}, got ${trackIds.length}` });
    }

    for (const id of currentIds) {
      if (!uniqueRequested.has(id)) {
        return reply.status(400).send({ error: `Missing track id in reorder payload: ${id}` });
      }
    }
    for (const id of trackIds) {
      if (!currentIds.includes(id)) {
        return reply.status(400).send({ error: `Unknown track id in reorder payload: ${id}` });
      }
    }

    const byId = new Map(project.tracks.map((t) => [t.id, t] as const));
    project.tracks = trackIds.map((id) => byId.get(id)!);

    const normalized = await writeProjectNormalized(projectPath, project);

    broadcastUpdate();
    server.log.info(`Reordered tracks: ${trackIds.join(', ')}`);
    return normalized;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Update keyframe
server.post('/api/project/keyframe', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, keyframeIndex, keyframeId, value, time, easing } = body;

  try {
    const project = await readProjectNormalized(projectPath);

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

    const normalized = await writeProjectNormalized(projectPath, project);
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated keyframe ${keyframeIndex} for ${property} on element ${elementId}`);
    
    return normalized;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Add or update animation keyframe
server.post('/api/project/animation', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, time, value, easing = 'linear', keyframeId } = body;

  try {
    const project = await readProjectNormalized(projectPath);

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

    const normalized = await writeProjectNormalized(projectPath, project);
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Added keyframe at t=${time}s for ${property} on element ${elementId}`);
    
    return normalized;
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
