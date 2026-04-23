#!/usr/bin/env node

import Fastify from 'fastify';
import { join, resolve, dirname } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import chokidar from 'chokidar';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { spawnSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';
const ASSETS_PATH = 'D:\\Coding\\Projects\\cutboard\\assets';
const FFMPEG = ffmpegStatic as unknown as string;

const server = Fastify({ logger: true });

// Store connected SSE clients
const sseClients = new Set<any>();

// Enable CORS for studio app
server.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});

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

function buildTimeline(project: any): TLEntry[] {
  const entries: TLEntry[] = [];
  for (const [id, el] of Object.entries(project.elements || {})) {
    const e = el as any;
    if (e.type !== 'video') continue;
    const asset = project.assets?.[e.assetId];
    if (!asset || asset.type !== 'video') continue;
    entries.push({
      id,
      src: asset.src,
      start: e.start,
      end: e.start + e.duration,
      trimStart: e.trimStart ?? 0,
    });
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

// Get project
server.get('/api/project', async (request, reply) => {
  const query = request.query as any;
  const projectPath = query.path || PROJECT_PATH;
  
  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    // Auto-normalize element transforms to match schema expectations.
    // (Prevents UI crashes when older projects only store partial transform objects.)
    let changed = false;
    if (project?.elements && typeof project.elements === 'object') {
      for (const el of Object.values(project.elements)) {
        if (!el || typeof el !== 'object') continue;
        const t = (el as any).transform;
        if (!t || typeof t !== 'object') {
          (el as any).transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
          changed = true;
          continue;
        }
        if (typeof t.x !== 'number') { t.x = 0; changed = true; }
        if (typeof t.y !== 'number') { t.y = 0; changed = true; }
        if (typeof t.scale !== 'number') { t.scale = 1; changed = true; }
        if (typeof t.rotation !== 'number') { t.rotation = 0; changed = true; }
        if (typeof t.opacity !== 'number') { t.opacity = 1; changed = true; }
      }
    }

    if (changed) {
      writeFileSync(projectPath, JSON.stringify(project, null, 2));
      // Broadcast so connected clients re-fetch a fully-normalized project.
      broadcastUpdate();
      server.log.info('Normalized project.json transforms');
    }

    return project;
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
    const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
    const meta = project.meta || {};
    const duration = Math.max(Number(meta.duration) || 1, 1);
    const t = Math.min(requestedTime, duration);

    const timeline = buildTimeline(project);
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

// Update element
server.post('/api/project/element', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, updates } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    if (!project.elements[elementId]) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    project.elements[elementId] = {
      ...project.elements[elementId],
      ...updates
    };

    // Normalize transform on write too (keeps project.json schema-consistent)
    const t = project.elements[elementId]?.transform;
    if (!t || typeof t !== 'object') {
      project.elements[elementId].transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    } else {
      if (typeof t.x !== 'number') t.x = 0;
      if (typeof t.y !== 'number') t.y = 0;
      if (typeof t.scale !== 'number') t.scale = 1;
      if (typeof t.rotation !== 'number') t.rotation = 0;
      if (typeof t.opacity !== 'number') t.opacity = 1;
    }

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Update keyframe
server.post('/api/project/keyframe', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, keyframeIndex, value, time, easing } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    // Find animations for this element and property
    const animationKey = Object.keys(project.animations || {}).find(key => {
      const anim = project.animations[key];
      return anim.target === elementId && anim.property === property;
    });

    if (!animationKey) {
      return reply.status(404).send({ error: 'Animation not found' });
    }

    const animation = project.animations[animationKey];
    if (!animation.keyframes[keyframeIndex]) {
      return reply.status(404).send({ error: 'Keyframe not found' });
    }

    if (typeof value !== 'undefined') {
      animation.keyframes[keyframeIndex].value = value;
    }
    if (typeof time === 'number') {
      animation.keyframes[keyframeIndex].time = time;
      // Keep keyframes sorted by time
      animation.keyframes.sort((a: any, b: any) => a.time - b.time);
    }
    if (typeof easing === 'string') {
      animation.easing = easing;
    }

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated keyframe ${keyframeIndex} for ${property} on element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Add or update animation keyframe
server.post('/api/project/animation', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, time, value, easing = 'linear' } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    if (!project.animations) {
      project.animations = {};
    }

    // Find existing animation for this element+property
    const animationKey = Object.keys(project.animations).find(key => {
      const anim = project.animations[key];
      return anim.target === elementId && anim.property === property;
    });

    if (animationKey) {
      // Add keyframe to existing animation
      const animation = project.animations[animationKey];
      animation.keyframes.push({ time, value, easing });
      // Sort keyframes by time
      animation.keyframes.sort((a: any, b: any) => a.time - b.time);
    } else {
      // Create new animation
      const animId = `anim_${Math.random().toString(36).substr(2, 6)}`;
      project.animations[animId] = {
        id: animId,
        target: elementId,
        property,
        keyframes: [{ time, value, easing }],
        easing
      };
    }

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Added keyframe at t=${time}s for ${property} on element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Start server
const start = async () => {
  try {
    await server.listen({ port: 3001 });
    console.log('🎬 CutBoard API Server running at http://localhost:3001');
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
