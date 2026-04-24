import type { Animation, EasingType, Keyframe, Project } from '../types/schema.js';

const TIME_EPS = 1e-6;

function quantizeTime(t: number): string {
  return Math.round(t / TIME_EPS).toString();
}

function hashHex(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fallbackKeyframeId(animationKey: string, index: number, kf: { time: number; value: number }): string {
  return `kf_${hashHex(`${animationKey}:${index}:${kf.time}:${kf.value}`)}`;
}

function randomKeyframeId(): string {
  return `kf_${hashHex(`${Date.now()}:${Math.random()}`)}`;
}

function sortKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.id.localeCompare(b.id);
  });
}

export function canonicalizeAnimations(project: Project): boolean {
  const groups = new Map<string, Array<{ key: string; anim: Animation }>>();
  for (const [key, anim] of Object.entries(project.animations || {})) {
    if (!anim || typeof anim !== 'object') continue;
    const gk = `${anim.target}::${anim.property}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk)!.push({ key, anim });
  }

  const out: Project['animations'] = {};
  let changed = false;

  for (const entries of groups.values()) {
    const sortedEntries = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    const canonicalKey = sortedEntries[0].key;

    const byTime = new Map<string, Keyframe>();
    for (const { key, anim } of sortedEntries) {
      const kfs = Array.isArray(anim.keyframes) ? anim.keyframes : [];
      for (let i = 0; i < kfs.length; i++) {
        const raw = kfs[i] as any;
        const time = Number(raw?.time);
        const value = Number(raw?.value);
        if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
        const id = typeof raw?.id === 'string' && raw.id.length > 0
          ? raw.id
          : fallbackKeyframeId(key, i, { time, value });
        const q = quantizeTime(time);
        // Last write wins across duplicate tracks for same target+property/time.
        byTime.set(q, { id, time, value });
      }
    }

    const merged = sortKeyframes([...byTime.values()]);
    const easing = sortedEntries.find((e) => typeof e.anim.easing === 'string')?.anim.easing ?? 'easeInOut';
    out[canonicalKey] = {
      id: canonicalKey,
      target: sortedEntries[0].anim.target,
      property: sortedEntries[0].anim.property,
      keyframes: merged,
      easing,
    };
    if (sortedEntries.length > 1) changed = true;
    if (sortedEntries[0].anim.id !== canonicalKey) changed = true;
  }

  const before = JSON.stringify(project.animations || {});
  const after = JSON.stringify(out);
  project.animations = out;
  return changed || before !== after;
}

function ensureCanonicalTrack(
  project: Project,
  target: string,
  property: string,
  easing: EasingType = 'easeInOut'
): { key: string; animation: Animation } {
  canonicalizeAnimations(project);
  const existing = Object.entries(project.animations).find(([, a]) => a.target === target && a.property === property);
  if (existing) {
    const [key, animation] = existing;
    if (animation.id !== key) animation.id = key;
    if (!animation.easing) animation.easing = easing;
    return { key, animation };
  }

  let key = `anim_${hashHex(`${target}::${property}`)}`;
  while (project.animations[key] && (project.animations[key].target !== target || project.animations[key].property !== property)) {
    key = `anim_${hashHex(`${target}::${property}:${Math.random()}`)}`;
  }

  const anim: Animation = {
    id: key,
    target,
    property,
    keyframes: [],
    easing,
  };
  project.animations[key] = anim;
  return { key, animation: anim };
}

export function upsertAnimationKeyframe(
  project: Project,
  opts: {
    target: string;
    property: string;
    time: number;
    value: number;
    easing?: EasingType;
    keyframeId?: string;
    keyframeIndex?: number;
  }
): { animationId: string; keyframeId: string } {
  const easing = opts.easing ?? 'easeInOut';
  const { key: animationId, animation } = ensureCanonicalTrack(project, opts.target, opts.property, easing);
  animation.easing = easing;

  const keyframes = sortKeyframes((animation.keyframes || []).map((k, idx) => ({
    id: typeof (k as any).id === 'string' && (k as any).id.length > 0 ? (k as any).id : fallbackKeyframeId(animationId, idx, k),
    time: Number(k.time),
    value: Number(k.value),
  })).filter((k) => Number.isFinite(k.time) && Number.isFinite(k.value)));

  let targetIdx = -1;
  if (opts.keyframeId) {
    targetIdx = keyframes.findIndex((k) => k.id === opts.keyframeId);
  }
  if (targetIdx < 0 && typeof opts.keyframeIndex === 'number') {
    targetIdx = opts.keyframeIndex >= 0 && opts.keyframeIndex < keyframes.length ? opts.keyframeIndex : -1;
  }
  if (targetIdx < 0) {
    const q = quantizeTime(opts.time);
    targetIdx = keyframes.findIndex((k) => quantizeTime(k.time) === q);
  }

  let keyframeId = opts.keyframeId && opts.keyframeId.length > 0 ? opts.keyframeId : randomKeyframeId();
  if (targetIdx >= 0) {
    keyframeId = keyframes[targetIdx].id;
    keyframes[targetIdx] = {
      id: keyframeId,
      time: opts.time,
      value: opts.value,
    };
  } else {
    keyframes.push({
      id: keyframeId,
      time: opts.time,
      value: opts.value,
    });
  }

  animation.keyframes = sortKeyframes(keyframes);
  canonicalizeAnimations(project);
  return { animationId, keyframeId };
}
