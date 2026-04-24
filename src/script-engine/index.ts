import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadProject, saveProject, computeDuration } from '../engine/project.js';
import { upsertAnimationKeyframe } from '../shared/animation-model.js';
import type { Project, VideoElement, ImageElement, TextElement, AudioElement, CompositionElement } from '../types/schema.js';
import { randomId } from '../utils/id.js';

// ─── ProjectAPI type ────────────────────────────────────────────────────────
export interface AddVideoOpts {
  assetId: string;
  start: number;
  duration: number;
  trimStart?: number;
  trimDuration?: number;
}

export interface RegisterAssetOpts {
  type: 'video' | 'image' | 'audio' | 'composition';
  src: string;
}

export interface AddImageOpts {
  assetId: string;
  start: number;
  duration: number;
  trimStart?: number;
  trimDuration?: number;
}

export interface AddTextOpts {
  content: string;
  start: number;
  duration: number;
  style?: { fontSize?: number; color?: string; fontFamily?: string };
}

export interface AddAudioOpts {
  id?: string;
  assetId: string;
  start: number;
  duration: number;
  trimStart?: number;
  trimDuration?: number;
  volume?: number;
}

export interface AddCompositionOpts {
  id?: string;
  assetId: string;
  start: number;
  duration: number;
  trimStart?: number;
}

export interface SetKeyframeOpts {
  elementId: string;
  property: string;
  time: number;
  value: number;
}

export interface AddTrackOpts {
  type: 'video' | 'image' | 'text' | 'audio' | 'overlay';
  label?: string;
  elementIds?: string[];
}

export interface ProjectAPI {
  registerAsset(opts: RegisterAssetOpts): string;
  addVideo(opts: AddVideoOpts): string;
  addComposition(opts: AddCompositionOpts): string;
  addImage(opts: AddImageOpts): string;
  addText(opts: AddTextOpts): string;
  addAudio(opts: AddAudioOpts): string;
  removeElement(id: string): void;
  setKeyframe(opts: SetKeyframeOpts): void;
  addTrack(opts: AddTrackOpts): string;
}

// ─── Script API ────────────────────────────────────────────────────────────
function createAPI(project: Project, _root: string): ProjectAPI {
  return {
    registerAsset(opts: RegisterAssetOpts): string {
      // Use src as the assetId for simplicity
      const assetId = opts.src;
      const asset = {
        type: opts.type,
        src: opts.src,
        duration: opts.type === 'video' ? 0 : undefined, // Will be probed during render
      } as any;
      project.assets[assetId] = asset;
      return assetId;
    },

    addVideo(opts: AddVideoOpts): string {
      const id = `el_video_${randomId(6)}`;
      const el: VideoElement = {
        id,
        type: 'video',
        assetId: opts.assetId,
        start: opts.start,
        duration: opts.duration,
        trimStart: opts.trimStart ?? 0,
        trimDuration: opts.trimDuration ?? opts.duration,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
      project.elements[id] = el;
      return id;
    },

    addComposition(opts: AddCompositionOpts): string {
      const id = opts.id ?? `el_comp_${randomId(6)}`;
      const el: CompositionElement = {
        id,
        type: 'composition',
        assetId: opts.assetId,
        start: opts.start,
        duration: opts.duration,
        trimStart: opts.trimStart ?? 0,
        trimDuration: opts.duration,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
      project.elements[id] = el;
      return id;
    },

    addImage(opts: AddImageOpts): string {
      const id = `el_image_${randomId(6)}`;
      const el: ImageElement = {
        id,
        type: 'image',
        assetId: opts.assetId,
        start: opts.start,
        duration: opts.duration,
        trimStart: opts.trimStart ?? 0,
        trimDuration: opts.trimDuration ?? opts.duration,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
      project.elements[id] = el;
      return id;
    },

    addText(opts: AddTextOpts): string {
      const id = `el_text_${randomId(6)}`;
      const el: TextElement = {
        id,
        type: 'text',
        content: opts.content,
        style: { fontSize: opts.style?.fontSize ?? 48, color: opts.style?.color ?? '#ffffff' },
        start: opts.start,
        duration: opts.duration,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
      project.elements[id] = el;
      return id;
    },

    addAudio(opts: AddAudioOpts): string {
      const id = opts.id ?? `el_audio_${randomId(6)}`;
      const el: AudioElement = {
        id,
        type: 'audio',
        assetId: opts.assetId,
        start: opts.start,
        duration: opts.duration,
        trimStart: opts.trimStart ?? 0,
        trimDuration: opts.trimDuration ?? opts.duration,
        volume: opts.volume ?? 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      };
      project.elements[id] = el;
      return id;
    },

    removeElement(id: string): void {
      delete project.elements[id];
      for (const track of project.tracks) {
        track.elements = track.elements.filter(eid => eid !== id);
      }
      for (const [key, anim] of Object.entries(project.animations)) {
        if (anim.target === id) delete project.animations[key];
      }
      for (const [key, fx] of Object.entries(project.effects)) {
        if (fx.target === id) delete project.effects[key];
      }
    },

    setKeyframe(opts: SetKeyframeOpts): void {
      upsertAnimationKeyframe(project, {
        target: opts.elementId,
        property: opts.property,
        time: opts.time,
        value: opts.value,
        easing: 'easeInOut',
      });
    },

    addTrack(opts: AddTrackOpts): string {
      const id = `track_${opts.type}_${randomId(4)}`;
      project.tracks.push({ id, type: opts.type, label: opts.label, elements: opts.elementIds ?? [] });
      return id;
    },
  };
}

// ─── Run Script ─────────────────────────────────────────────────────────────
export async function runScript(scriptPath: string, root = '.'): Promise<void> {
  const project = loadProject(root);
  const api = createAPI(project, root);

  const absPath = resolve(root, scriptPath);
  const code = readFileSync(absPath, 'utf-8');

  const fn = new Function('api', `
    return (async function() {
      ${code}
    })();
  `);
  await fn(api);
  project.meta.duration = computeDuration(project.elements);
  saveProject(project, root);
  console.log(`✓ Script "${scriptPath}" ran successfully`);
}

// ─── Quick eval (CLI one-liner) ────────────────────────────────────────────
export async function evalScript(expr: string, root = '.'): Promise<void> {
  const project = loadProject(root);
  const api = createAPI(project, root);

  const fn = new Function('api', `return (async () => { ${expr} })()`);
  await fn(api);
  project.meta.duration = computeDuration(project.elements);
  saveProject(project, root);
  console.log('✓ Done');
}
