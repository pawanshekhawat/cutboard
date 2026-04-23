import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { mkdirSync } from 'fs';
import type { Project, VideoElement, TextElement, Animation, Keyframe, AudioElement } from '../types/schema.js';
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
type TLEntry = { id: string; src: string; start: number; end: number; trimStart: number };
type AudioTLEntry = { id: string; src: string; start: number; duration: number; trimStart: number; volume: number };

function buildTimeline(project: Project): TLEntry[] {
  const entries: TLEntry[] = [];
  for (const [id, el] of Object.entries(project.elements)) {
    if (el.type !== 'video') continue;
    const asset = project.assets[el.assetId];
    if (!asset || asset.type !== 'video') continue;
    const vid = el as VideoElement;
    entries.push({ id, src: (asset as any).src, start: el.start, end: el.start + el.duration, trimStart: vid.trimStart ?? 0 });
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
  const timeline = buildTimeline(project);
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

  // ── Video clips + optional text ───────────────────────────────────────
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

  // Trim + offset each clip
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const ii = assetIdx.get(e.src)!;
    const clipDur = e.end - e.start;
    const fx = getVideoEffectsFilter(project, e.id);
    fl.push(
      `[${ii}:v]trim=start=${e.trimStart}:duration=${clipDur},setpts=PTS-STARTPTS+${e.start}/TB,` +
      `scale=${meta.resolution.width}:${meta.resolution.height}:force_original_aspect_ratio=decrease,setsar=1${fx}[v${i}]`
    );
  }

  // Chain overlays: each clip shows only during its global time window
  let prev = '[base]';
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const outL = i === timeline.length - 1 ? '[vout]' : `[tmp${i}]`;
    fl.push(`${prev}[v${i}]overlay=0:0:enable='between(t,${e.start},${e.end})'${outL}`);
    prev = outL;
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
      `[${ii}:a]atrim=start=${a.trimStart}:duration=${a.duration},asetpts=PTS-STARTPTS,` +
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