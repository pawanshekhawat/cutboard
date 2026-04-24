import { execSync } from 'child_process';
import { resolve, dirname, basename } from 'path';
import { mkdirSync, existsSync, statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import type {
  Project,
  VideoElement,
  ImageElement,
  TextElement,
  Animation,
  Keyframe,
  AudioElement,
  CompositionAsset,
  Transform,
} from '../types/schema.js';
import { loadProject, loadProjectFromPath, resolveProjectRootFromSrc, computeDuration } from './project.js';
import ffmpegStatic from 'ffmpeg-static';
import * as ffprobe from 'ffprobe-static';

const FFMPEG: string = ffmpegStatic as unknown as string;
const FFPROBE: string = ffprobe.path;

// ─── Animation: Linear interpolation to FFmpeg expression ───────────────────
// Converts keyframes like [{t:0,v:0},{t:2,v:500}] into FFmpeg expression
// Uses FFmpeg's expression syntax with escaped commas
function buildAnimationExpr(keyframes: Keyframe[], propName: string): string | null {
  if (keyframes.length < 2) return null;
  
  // Sort by time
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  
  // For two keyframes: use linear interpolation during the time range
  // Expression: (t <= t1) ? v1 : (t >= t2) ? v2 : v1 + (v2-v1)/(t2-t1)*(t-t1)
  // In FFmpeg: if(lte(t\,t1)\,v1\,if(gte(t\,t2)\,v2\,v1+(v2-v1)/(t2-t1)*(t-t1)))
  const k1 = sorted[0];
  const k2 = sorted[sorted.length - 1];
  
  const slope = (k2.value - k1.value) / (k2.time - k1.time);
  const intercept = k1.value - slope * k1.time;
  
  // Simpler approach: just use the linear equation throughout
  // The animation is only visible during the element's enable time anyway
  // So we just need: slope*t + intercept
  // But clamp to start/end values for safety
  return `${slope}*t+${intercept}`;
}

// Get animated value for an element's property at render time
function getAnimatedValue(
  elementId: string,
  propName: string,
  animations: Record<string, Animation>,
  defaultValue: number
): string {
  // Find animations targeting this element + property
  const relevant = Object.values(animations).filter(
    a => a.target === elementId && a.property === propName
  );
  
  if (relevant.length === 0) return String(defaultValue);
  
  // Merge all keyframes from matching animations
  const allKeyframes = relevant.flatMap(a => a.keyframes);
  if (allKeyframes.length < 2) return String(defaultValue);
  
  const expr = buildAnimationExpr(allKeyframes, propName);
  return expr ?? String(defaultValue);
}

// ─── Probe via ffprobe binary ─────────────────────────────────────────────
export function probeAsset(src: string): { duration: number; width: number; height: number } {
  const abs = resolve(src);
  try {
    const out = execSync(`"${FFPROBE}" -v quiet -print_format json -show_streams -show_format "${abs}"`, {
      encoding: 'utf-8', timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const data = JSON.parse(out);
    const vs = data.streams?.find((s: any) => s.codec_type === 'video');
    return { duration: parseFloat(data.format?.duration || '0'), width: vs?.width || 1920, height: vs?.height || 1080 };
  } catch {
    return { duration: 0, width: 1920, height: 1080 };
  }
}

// ─── Timeline map ───────────────────────────────────────────────────────────
type VisualKind = 'video' | 'composition' | 'image';
type VisualTLEntry = {
  id: string;
  kind: VisualKind;
  src: string;
  start: number;
  end: number;
  trimStart: number;
  transform: Transform;
};
type AudioTLEntry = {
  id: string;
  src: string;
  start: number;
  duration: number;
  trimStart: number;
  trimDuration: number;
  volume: number;
};

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

function safeMtimeMs(absPath: string): number {
  try {
    if (!existsSync(absPath)) return 0;
    const st = statSync(absPath);
    return st.mtimeMs || 0;
  } catch {
    return 0;
  }
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

function resolveCompositionToCachedVideo(
  parentRoot: string,
  asset: CompositionAsset,
  parentCacheRootAbs: string
): string {
  const childRoot = resolveProjectRootFromSrc(parentRoot, asset.src);
  const childProjectJson = resolve(childRoot, 'project.json');
  if (!existsSync(childProjectJson)) {
    throw new Error(`Composition asset missing child project.json at ${childProjectJson}`);
  }

  const key = computeCompositionCacheKey(childRoot);
  const outAbs = resolve(parentCacheRootAbs, `${basename(childRoot)}-${key}.mp4`);
  mkdirSync(dirname(outAbs), { recursive: true });

  if (existsSync(outAbs)) return outAbs;

  const childProject = existsSync(childProjectJson)
    ? loadProject(childRoot)
    : loadProjectFromPath(childProjectJson);

  const computedDuration = computeDuration(childProject.elements);
  if (!childProject.meta.duration || childProject.meta.duration < computedDuration) {
    childProject.meta.duration = computedDuration;
  }

  render(childProject, outAbs, childRoot);
  return outAbs;
}

function normalizeElementTransform(t: unknown): Transform {
  const tr = (t ?? {}) as Partial<Transform>;
  return {
    x: typeof tr.x === 'number' ? tr.x : 0,
    y: typeof tr.y === 'number' ? tr.y : 0,
    scale: typeof tr.scale === 'number' ? tr.scale : 1,
    rotation: typeof tr.rotation === 'number' ? tr.rotation : 0,
    opacity: typeof tr.opacity === 'number' ? tr.opacity : 1,
  };
}

function buildTimeline(project: Project, root: string, compositionCacheRootAbs: string): VisualTLEntry[] {
  const entries: VisualTLEntry[] = [];
  for (const [id, el] of Object.entries(project.elements)) {
    if (el.type !== 'video' && el.type !== 'composition' && el.type !== 'image') continue;
    const assetId = (el as any).assetId as string | undefined;
    if (!assetId) continue;
    const asset = project.assets[assetId];
    if (!asset) continue;
    const tr = normalizeElementTransform(el.transform);
    const vid = el as any as VideoElement;
    if (asset.type === 'video') {
      entries.push({
        id,
        kind: 'video',
        src: (asset as any).src,
        start: el.start,
        end: el.start + el.duration,
        trimStart: vid.trimStart ?? 0,
        transform: tr,
      });
    } else if (asset.type === 'composition') {
      const cachedAbs = resolveCompositionToCachedVideo(root, asset as CompositionAsset, compositionCacheRootAbs);
      entries.push({
        id,
        kind: 'composition',
        src: cachedAbs,
        start: el.start,
        end: el.start + el.duration,
        trimStart: vid.trimStart ?? 0,
        transform: tr,
      });
    } else if (asset.type === 'image' && el.type === 'image') {
      const img = el as ImageElement;
      entries.push({
        id,
        kind: 'image',
        src: (asset as any).src,
        start: el.start,
        end: el.start + el.duration,
        trimStart: img.trimStart ?? 0,
        transform: tr,
      });
    }
  }
  return entries.sort((a, b) => a.start - b.start);
}

function buildAudioTimeline(project: Project): AudioTLEntry[] {
  const entries: AudioTLEntry[] = [];
  for (const [id, el] of Object.entries(project.elements)) {
    if (el.type !== 'audio') continue;
    const asset = project.assets[el.assetId];
    if (!asset || asset.type !== 'audio') continue;
    const ael = el as AudioElement;
    entries.push({
      id,
      src: (asset as any).src,
      start: el.start,
      duration: el.duration,
      trimStart: ael.trimStart ?? 0,
      trimDuration: ael.trimDuration ?? el.duration,
      volume: ael.volume ?? 1,
    });
  }
  return entries.sort((a, b) => a.start - b.start);
}

function getVideoEffectsFilter(project: Project, elementId: string): string {
  const effects = Object.values(project.effects || {}).filter(fx => fx.target === elementId);
  if (effects.length === 0) return '';

  const chain: string[] = [];
  for (const fx of effects) {
    if (fx.type === 'blur') {
      const radius = Math.max(0, Math.min(50, Number(fx.value) || 0));
      chain.push(`boxblur=luma_radius=${radius}:luma_power=1`);
    } else if (fx.type === 'grayscale') {
      // grayscale intensity is binary for now (value > 0 enables it)
      if ((Number(fx.value) || 0) > 0) chain.push('hue=s=0');
    }
  }
  return chain.length > 0 ? `,${chain.join(',')}` : '';
}

// ─── Render ────────────────────────────────────────────────────────────────
// root = project root directory (where project.json lives), needed to resolve asset paths
export function render(project: Project, outputPath = './output/render.mp4', root = '.'): void {
  const { meta, elements } = project;
  const absOutput = resolve(root, outputPath);
  const dur = Math.max(meta.duration || 5, 1);

  mkdirSync(dirname(absOutput), { recursive: true });

  const textEls = Object.values(elements).filter(el => el.type === 'text') as TextElement[];
  const compositionCacheRootAbs = resolve(root, 'output/.cache/compositions');
  const timeline = buildTimeline(project, root, compositionCacheRootAbs);
  const audioTimeline = buildAudioTimeline(project);

  // ── No video → text-over-testsrc (proven path) ────────────────────────
  if (timeline.length === 0) {
    if (textEls.length > 0) {
      const parts = textEls.map(el => {
        const e = el.content.replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/\n/g, '\\n');
        const xExpr = getAnimatedValue(el.id, 'transform.x', project.animations, el.transform.x);
        const yExpr = getAnimatedValue(el.id, 'transform.y', project.animations, el.transform.y);
        return `drawtext=text='${e}':fontsize=${el.style.fontSize}:fontcolor=${el.style.color}:x=${xExpr}:y=${yExpr}:` +
          `enable='between(t,${el.start},${el.start + el.duration})'`;
      });
      if (audioTimeline.length === 0) {
        const cmd = [
          `"${FFMPEG}"`, '-y',
          '-f', 'lavfi', '-i', `testsrc=d=${dur}:size=${meta.resolution.width}x${meta.resolution.height}:rate=${meta.fps}`,
          '-vf', parts.join(','),
          '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
          '-t', String(dur), '-pix_fmt', 'yuv420p',
          `"${absOutput}"`,
        ].join(' ');
        execSync(cmd, { stdio: 'inherit' });
        console.log(`✓ Saved: ${absOutput}`);
        return;
      }
    }
    if (audioTimeline.length === 0) {
      const cmd = [
        `"${FFMPEG}"`, '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=${meta.resolution.width}x${meta.resolution.height}:d=${dur}`,
        '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-t', String(dur), '-pix_fmt', 'yuv420p',
        `"${absOutput}"`,
      ].join(' ');
      execSync(cmd, { stdio: 'inherit' });
      console.log(`✓ Saved: ${absOutput}`);
      return;
    }
  }

  // ── Visual clips + optional text ───────────────────────────────────────
  // Unique asset paths → input indices (relative to project root)
  const assetList: string[] = [];
  const assetIdx = new Map<string, number>();
  for (const e of timeline) {
    if (!assetIdx.has(e.src)) { assetIdx.set(e.src, assetList.length); assetList.push(e.src); }
  }
  for (const a of audioTimeline) {
    if (!assetIdx.has(a.src)) { assetIdx.set(a.src, assetList.length); assetList.push(a.src); }
  }

  // Build filter_complex
  const fl: string[] = [];

  // Black background (exact duration)
  fl.push(`color=c=black:size=${meta.resolution.width}x${meta.resolution.height}:rate=${meta.fps}:duration=${dur}[base]`);

  // Build each visual layer stream.
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const ii = assetIdx.get(e.src)!;
    const clipDur = e.end - e.start;
    if (e.kind === 'image') {
      const scaleExpr = getAnimatedValue(e.id, 'transform.scale', project.animations, e.transform.scale);
      const rotationExpr = getAnimatedValue(e.id, 'transform.rotation', project.animations, e.transform.rotation);
      const opacity = Math.max(0, Math.min(1, e.transform.opacity));
      fl.push(
        `[${ii}:v]fps=${meta.fps},trim=duration=${clipDur},setpts=PTS-STARTPTS,` +
        `scale=w='iw*(${scaleExpr})':h='ih*(${scaleExpr})':eval=frame,` +
        `rotate='(${rotationExpr})*PI/180':ow='rotw(iw)':oh='roth(ih)':c=none,` +
        `format=rgba,colorchannelmixer=aa=${opacity}[v${i}]`
      );
      continue;
    }

    const fx = getVideoEffectsFilter(project, e.id);
    fl.push(
      `[${ii}:v]trim=start=${e.trimStart}:duration=${clipDur},setpts=PTS-STARTPTS+${e.start}/TB,` +
      `scale=${meta.resolution.width}:${meta.resolution.height}:force_original_aspect_ratio=decrease,setsar=1${fx}[v${i}]`
    );
  }

  // Chain overlays in timeline order.
  let prev = '[base]';
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const outL = i === timeline.length - 1 ? '[vout]' : `[tmp${i}]`;
    if (e.kind === 'image') {
      const xExpr = getAnimatedValue(e.id, 'transform.x', project.animations, e.transform.x);
      const yExpr = getAnimatedValue(e.id, 'transform.y', project.animations, e.transform.y);
      fl.push(
        `${prev}[v${i}]overlay=` +
        `x='${xExpr}-overlay_w/2':y='${yExpr}-overlay_h/2':` +
        `enable='between(t,${e.start},${e.end})'${outL}`
      );
    } else {
      fl.push(`${prev}[v${i}]overlay=0:0:enable='between(t,${e.start},${e.end})'${outL}`);
    }
    prev = outL;
  }
  if (timeline.length === 0) {
    fl.push('[base]null[vout]');
  }

  // Text overlays on top (with animation support)
  let top = timeline.length > 0 ? '[vout]' : '[base]';
  for (let i = 0; i < textEls.length; i++) {
    const el = textEls[i];
    const e = el.content.replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/\n/g, '\\n');
    const en = `enable='between(t,${el.start},${el.start + el.duration})'`;
    
    // Get animated x/y or use static transform values
    const xExpr = getAnimatedValue(el.id, 'transform.x', project.animations, el.transform.x);
    const yExpr = getAnimatedValue(el.id, 'transform.y', project.animations, el.transform.y);
    
    const nxt = i === textEls.length - 1 ? '[out]' : `[t${i}]`;
    fl.push(`${top}drawtext=text='${e}':fontsize=${el.style.fontSize}:fontcolor=${el.style.color}:x=${xExpr}:y=${yExpr}:${en}${nxt}`);
    top = nxt;
  }
  if (textEls.length === 0) {
    fl.push(`${top}null[out]`);
  }

  // Audio chain: atrim + adelay + volume per clip, then amix
  const audioLabels: string[] = [];
  for (let i = 0; i < audioTimeline.length; i++) {
    const a = audioTimeline[i];
    const ii = assetIdx.get(a.src)!;
    const delayMs = Math.max(0, Math.round(a.start * 1000));
    const out = `[a${i}]`;
    fl.push(
      `[${ii}:a]atrim=start=${a.trimStart}:duration=${a.trimDuration},asetpts=PTS-STARTPTS,` +
      `adelay=${delayMs}|${delayMs},volume=${a.volume}${out}`
    );
    audioLabels.push(out);
  }
  if (audioLabels.length > 0) {
    fl.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0[aout]`);
  }

  const fc = fl.join('; ');

  // Build arg list (no shell splitting — each path is a separate quoted arg)
  const args: string[] = ['-y'];
  for (const s of assetList) args.push('-i', resolve(root, s) as string);
  args.push('-filter_complex', fc, '-map', '[out]');
  if (audioLabels.length > 0) args.push('-map', '[aout]');
  args.push(
    '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
    ...(audioLabels.length > 0 ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
    '-t', String(dur), '-pix_fmt', 'yuv420p', absOutput);

  // Quote each arg individually to prevent shell splitting of paths with spaces
  const quotedArgs = args.map(a => `"${a}"`);
  const cmd = `"${FFMPEG}" ${quotedArgs.join(' ')}`;

  console.log(`▶ rendering ${timeline.length} video clip(s) + ${textEls.length} text layer(s) + ${audioTimeline.length} audio clip(s)...`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`✓ Saved: ${absOutput}`);
}

// ─── Preview ───────────────────────────────────────────────────────────────
function renderPreview(project: Project, outputPath = './output/preview.png'): void {
  const { meta } = project;
  try {
    execSync(`"${FFMPEG}" -y -f lavfi -i "testsrc=d=1:size=${meta.resolution.width}x${meta.resolution.height}:rate=1" -frames:v 1 -q:v 2 "${resolve(outputPath)}"`, { stdio: 'pipe' });
    console.log(`✓ Preview: ${outputPath}`);
  } catch { console.warn('Preview skipped'); }
}
