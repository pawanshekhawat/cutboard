import { SCHEMA_VERSION, type Project, type Transform } from '../types/schema.js';
import { canonicalizeAnimations } from './animation-model.js';

function toFiniteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeUnitInterval(value: unknown, fallback: number): number {
  const raw = toFiniteNumber(value, fallback);
  // Backward compatibility for legacy percent values (e.g., 100 => 1).
  const normalized = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return clamp(normalized, 0, 1);
}

function normalizeTransform(input: unknown): Transform {
  const t = (input ?? {}) as Record<string, unknown>;
  return {
    x: toFiniteNumber(t.x, 0),
    y: toFiniteNumber(t.y, 0),
    scale: toFiniteNumber(t.scale, 1),
    rotation: toFiniteNumber(t.rotation, 0),
    opacity: normalizeUnitInterval(t.opacity, 1),
  };
}

function normalizeMediaTiming(
  element: Record<string, unknown>,
  duration: number
): { trimStart: number; trimDuration: number } {
  const trimStart = Math.max(0, toFiniteNumber(element.trimStart, 0));
  const trimDuration = Math.max(0, toFiniteNumber(element.trimDuration, duration));
  return {
    trimStart,
    trimDuration: trimDuration > 0 ? trimDuration : duration,
  };
}

export function normalizeProjectContract(raw: unknown): { project: Project; changed: boolean } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('project.json must be an object');
  }

  const p = raw as Record<string, any>;
  if (p.version !== SCHEMA_VERSION) {
    throw new Error(`Schema version mismatch: expected ${SCHEMA_VERSION}, got ${p.version}`);
  }
  if (!p.meta || typeof p.meta !== 'object') throw new Error('meta is required');
  if (!p.assets || typeof p.assets !== 'object') throw new Error('assets must be an object');
  if (!Array.isArray(p.tracks)) throw new Error('tracks must be an array');
  if (!p.elements || typeof p.elements !== 'object') throw new Error('elements must be an object');
  if (!p.animations || typeof p.animations !== 'object') p.animations = {};
  if (!p.effects || typeof p.effects !== 'object') p.effects = {};

  const before = JSON.stringify(p);

  p.meta.fps = Math.max(1, toFiniteNumber(p.meta.fps, 30));
  p.meta.duration = Math.max(0, toFiniteNumber(p.meta.duration, 0));
  if (!p.meta.resolution || typeof p.meta.resolution !== 'object') {
    p.meta.resolution = { width: 1920, height: 1080 };
  }
  p.meta.resolution.width = Math.max(1, Math.floor(toFiniteNumber(p.meta.resolution.width, 1920)));
  p.meta.resolution.height = Math.max(1, Math.floor(toFiniteNumber(p.meta.resolution.height, 1080)));

  for (const [id, rawEl] of Object.entries(p.elements as Record<string, any>)) {
    if (!rawEl || typeof rawEl !== 'object') {
      delete p.elements[id];
      continue;
    }

    rawEl.id = typeof rawEl.id === 'string' && rawEl.id.length > 0 ? rawEl.id : id;
    rawEl.start = Math.max(0, toFiniteNumber(rawEl.start, 0));
    rawEl.duration = Math.max(0, toFiniteNumber(rawEl.duration, 0));
    rawEl.transform = normalizeTransform(rawEl.transform);

    if (rawEl.type === 'audio') {
      const media = normalizeMediaTiming(rawEl, rawEl.duration);
      rawEl.trimStart = media.trimStart;
      rawEl.trimDuration = media.trimDuration;
      rawEl.volume = normalizeUnitInterval(rawEl.volume, 1);
    }

    if (rawEl.type === 'video' || rawEl.type === 'composition') {
      const media = normalizeMediaTiming(rawEl, rawEl.duration);
      rawEl.trimStart = media.trimStart;
      rawEl.trimDuration = media.trimDuration;
    }
  }

  // Canonical animation model:
  // - one track per target+property
  // - deterministic keyframe sorting
  // - stable keyframe IDs
  canonicalizeAnimations(p as Project);

  const after = JSON.stringify(p);
  return { project: p as Project, changed: before !== after };
}
