import { getProject, onChange, val } from '@theatre/core';
import studio from '@theatre/studio';
import type { ISheet, ISheetObject } from '@theatre/core';
import type { ProjectData } from './api';
import { api } from './api';
import { PROJECT_PATH } from './config';
import { isElementLocked, lockElement, unlockElement } from './theatre-sync';

type TheatreObjectValues = {
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
};
type TheatreAudioValues = {
  volume: number;
  start: number;
};

type ElementRuntime = {
  object: ISheetObject<any>;
  elementType: ProjectData['elements'][string]['type'];
  unsubscribeValues: () => void;
};

type Runtime = {
  sheet: ISheet;
  elements: Map<string, ElementRuntime>;
  unsubscribePosition: () => void;
};

let runtime: Runtime | null = null;
const LOCAL_EDIT_CONFLICT_HOLD_MS = 1200;
const TIME_EPS = 1e-3;
const canonicalAnimationIndex = new Map<string, {
  animationId: string;
  easing?: string;
  keyframes: Array<{ id: string; time: number; value: number }>;
}>();
const localConflictUntil = new Map<string, number>();
const writeQueues = new Map<string, Promise<void>>();

function trackKey(target: string, property: string): string {
  return `${target}::${property}`;
}

function queueWrite(key: string, op: () => Promise<void>) {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(op)
    .catch((err) => {
      console.error(`[theatre-writeback] ${key}`, err);
    })
    .finally(() => {
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    });
  writeQueues.set(key, next);
}

function markLocalConflictWindow(target: string, property: string) {
  localConflictUntil.set(trackKey(target, property), Date.now() + LOCAL_EDIT_CONFLICT_HOLD_MS);
}

function isLocalConflictProtected(target: string, property: string): boolean {
  const until = localConflictUntil.get(trackKey(target, property)) ?? 0;
  if (until <= Date.now()) {
    localConflictUntil.delete(trackKey(target, property));
    return false;
  }
  return true;
}

function approxEq(a: number, b: number, eps = TIME_EPS) {
  return Math.abs(a - b) < eps;
}

function getCanonicalTrack(target: string, property: string) {
  return canonicalAnimationIndex.get(trackKey(target, property));
}

function setCanonicalAnimationsFromProject(projectJson: ProjectData) {
  canonicalAnimationIndex.clear();
  for (const anim of Object.values(projectJson.animations || {})) {
    const keyframes = [...(anim.keyframes || [])]
      .filter((k) => Number.isFinite(Number(k.time)) && Number.isFinite(Number(k.value)))
      .map((k, idx) => ({
        id: typeof k.id === 'string' && k.id.length > 0 ? k.id : `kf_${anim.id}_${idx}`,
        time: Number(k.time),
        value: Number(k.value),
      }))
      .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id.localeCompare(b.id)));
    canonicalAnimationIndex.set(trackKey(anim.target, anim.property), {
      animationId: anim.id,
      easing: anim.easing,
      keyframes,
    });
  }
}

function normalizeTransform(t: any): TheatreObjectValues['transform'] {
  return {
    x: typeof t?.x === 'number' ? t.x : 0,
    y: typeof t?.y === 'number' ? t.y : 0,
    scale: typeof t?.scale === 'number' ? t.scale : 1,
    rotation: typeof t?.rotation === 'number' ? t.rotation : 0,
    opacity: typeof t?.opacity === 'number' ? t.opacity : 1,
  };
}

function toPointer(obj: any, prop: string) {
  const parts = prop.split('.');
  let cur = obj.props;
  for (const p of parts) cur = cur[p];
  return cur;
}

/**
 * Initializes Theatre (Project + Sheet + Objects) from project.json.
 * Seeds existing keyframes from project.json animations by setting values
 * at keyframe times via studio.transaction().
 */
export async function initializeTheatreNative(
  projectJson: ProjectData,
  opts: {
    onSequencePosition?: (t: number) => void;
    onValues?: (elementId: string, values: TheatreObjectValues) => void;
  } = {}
): Promise<void> {
  // Studio must be initialized at the entry point (main.tsx). We only use its APIs here.
  const sAny = studio as any;
  const sImpl = typeof sAny?.transaction === 'function' ? sAny : typeof sAny?.default?.transaction === 'function' ? sAny.default : null;

  // Dispose previous runtime
  if (runtime) {
    runtime.unsubscribePosition?.();
    for (const r of runtime.elements.values()) r.unsubscribeValues?.();
    runtime = null;
  }

  const theatreProject = getProject('CutBoard');
  // Theatre Studio may async-load project state; avoid touching sheets until ready.
  await theatreProject.ready;
  const sheet = theatreProject.sheet('Scene');

  const elements = new Map<string, ElementRuntime>();
  setCanonicalAnimationsFromProject(projectJson);

  // Create objects for each element.
  for (const el of Object.values(projectJson.elements)) {
    const transform = normalizeTransform(el.transform);
    const obj =
      el.type === 'audio'
        ? sheet.object(el.id, {
            volume: typeof (el as any).volume === 'number' ? (el as any).volume : 1,
            start: typeof el.start === 'number' ? el.start : 0,
          })
        : sheet.object(el.id, {
            transform: {
              x: transform.x,
              y: transform.y,
              scale: transform.scale,
              rotation: transform.rotation,
              opacity: transform.opacity,
            },
          });

    // Keep default values synced from JSON when not actively editing.
    if (el.type === 'audio') {
      (obj as ISheetObject<TheatreAudioValues>).initialValue = {
        volume: typeof (el as any).volume === 'number' ? (el as any).volume : 1,
        start: typeof el.start === 'number' ? el.start : 0,
      };
    } else {
      (obj as ISheetObject<TheatreObjectValues>).initialValue = { transform };
    }

    const unsubscribeValues = obj.onValuesChange((newValues) => {
      opts.onValues?.(el.id, newValues as any);
    });

    elements.set(el.id, { object: obj, elementType: el.type, unsubscribeValues });
  }

  // Seed keyframes from project.json animations into Theatre.
  // Studio is initialized synchronously in main.tsx; we only need to wait for project.ready.
  if (projectJson.animations && sheet?.sequence && sImpl?.transaction) {
    const currentPos = sheet.sequence.position;
    for (const anim of Object.values(projectJson.animations)) {
      const r = elements.get(anim.target);
      if (!r) continue;
      let ptr: any;
      try {
        ptr = toPointer(r.object, anim.property);
      } catch {
        continue;
      }
      if (!ptr) continue;
      const sorted = [...anim.keyframes].sort((a, b) => a.time - b.time);
      for (const kf of sorted) {
        sheet.sequence.position = kf.time;
        sImpl.transaction(({ set }: any) => {
          set(ptr, kf.value);
        });
      }
    }
    sheet.sequence.position = currentPos;
  }

  // Subscribe to Theatre sequence position so the native timeline drives our app.
  const unsubscribePosition = onChange(sheet.sequence.pointer.position, (pos) => {
    opts.onSequencePosition?.(pos);
  });

  runtime = { sheet, elements, unsubscribePosition };
}

export function getTheatreSheet(): ISheet | null {
  return runtime?.sheet ?? null;
}

export function subscribeToTheatreElementValues(
  elementId: string,
  cb: (values: any) => void
): (() => void) | null {
  const r = runtime?.elements.get(elementId);
  if (!r) return null;
  return r.object.onValuesChange((v) => cb(v));
}

export function getTheatreElementTransform(elementId: string) {
  const r = runtime?.elements.get(elementId);
  if (!r) return null;
  return val(r.object.props.transform) as TheatreObjectValues['transform'];
}

/**
 * Apply external (SSE/project.json) changes to Theatre without interrupting active edits.
 * For now we sync base transforms; sequenced keyframes are left to Theatre UI.
 */
export function applyExternalProjectToTheatre(projectJson: ProjectData) {
  if (!runtime) return;
  setCanonicalAnimationsFromProject(projectJson);

  for (const el of Object.values(projectJson.elements)) {
    const r = runtime.elements.get(el.id);
    if (!r) continue;
    if (el.type === 'audio') {
      const volumeLocked = isElementLocked(el.id, 'volume');
      const startLocked = isElementLocked(el.id, 'start');
      const volumeConflict = isLocalConflictProtected(el.id, 'volume');
      const startConflict = isLocalConflictProtected(el.id, 'start');
      if (volumeLocked || startLocked || volumeConflict || startConflict) continue;
      r.object.initialValue = {
        volume: typeof (el as any).volume === 'number' ? (el as any).volume : 1,
        start: typeof el.start === 'number' ? el.start : 0,
      };
      continue;
    }
    const t = normalizeTransform(el.transform);

    // If any transform prop is locked, skip applying to avoid interrupting drags.
    const locked =
      isElementLocked(el.id, 'transform.x') ||
      isElementLocked(el.id, 'transform.y') ||
      isElementLocked(el.id, 'transform.scale') ||
      isElementLocked(el.id, 'transform.rotation') ||
      isElementLocked(el.id, 'transform.opacity');
    const conflictProtected =
      isLocalConflictProtected(el.id, 'transform.x') ||
      isLocalConflictProtected(el.id, 'transform.y') ||
      isLocalConflictProtected(el.id, 'transform.scale') ||
      isLocalConflictProtected(el.id, 'transform.rotation') ||
      isLocalConflictProtected(el.id, 'transform.opacity');
    // Conflict policy: while local Theatre edits are active/recent for a property,
    // skip applying external SSE values to avoid clobbering local user intent.
    if (locked || conflictProtected) continue;

    r.object.initialValue = { transform: t };
  }
}

/**
 * Set playhead position (seconds) in Theatre.
 */
export function setTheatreTime(t: number) {
  if (!runtime) return;
  runtime.sheet.sequence.position = t;
}

/**
 * Wire write-back: when Theatre values/keyframes change, write to backend.
 *
 * Strategy:
 * - For static (unsequenced) props: POST /api/project/element transform patch.
 * - For sequenced props: detect keyframe at current time and update/add via keyframe endpoints.
 *
 * This intentionally ignores pure playback-driven value changes by requiring that a keyframe exists
 * at the current time (or Theatre just created one by a user edit).
 */
export function enableTheatreWriteBack() {
  if (!runtime) return;
  const { sheet, elements } = runtime;

  function theatreHasKeyframeAtPosition(pointer: any, position: number): boolean {
    const getter = (sheet.sequence as any).__experimental_getKeyframes;
    if (typeof getter !== 'function') return false;
    const keyframes = getter(pointer) as Array<{ position: number; value: number }> | undefined;
    if (!keyframes || keyframes.length === 0) return false;
    return keyframes.some((k) => approxEq(k.position, position));
  }

  for (const [elementId, r] of elements.entries()) {
    const obj = r.object;
    const elementType = r.elementType;

    const sendTransformPatch = async (patch: Partial<TheatreObjectValues['transform']>) => {
      const keys = Object.keys(patch);
      if (keys.length === 0) return;
      // lock all touched props during write
      for (const k of keys) lockElement(elementId, `transform.${k}`);
      try {
        const updated = await api.updateElement(PROJECT_PATH, elementId, {
          transform: {
            ...(obj.value.transform as any),
            ...patch,
          },
        } as any);
        setCanonicalAnimationsFromProject(updated);
        for (const k of keys) markLocalConflictWindow(elementId, `transform.${k}`);
      } finally {
        for (const k of keys) unlockElement(elementId, `transform.${k}`);
      }
    };

    const sendAudioPatch = async (patch: { volume?: number; start?: number }) => {
      const keys = Object.keys(patch);
      if (keys.length === 0) return;
      for (const k of keys) lockElement(elementId, k);
      try {
        const updated = await api.updateElement(PROJECT_PATH, elementId, patch as any);
        setCanonicalAnimationsFromProject(updated);
        for (const k of keys) markLocalConflictWindow(elementId, k);
      } finally {
        for (const k of keys) unlockElement(elementId, k);
      }
    };

    const handleProp = (prop: keyof TheatreObjectValues['transform']) => {
      const pointer = (obj as any).props.transform[prop];

      return onChange(pointer, (raw) => {
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(value)) return;

        queueWrite(`wb:${elementId}:transform.${prop}`, async () => {
        // Respect locks to avoid loops when applying external updates.
        const lockKey = `transform.${prop}`;
        if (isElementLocked(elementId, lockKey)) return;

        const position = sheet.sequence.position;
        const track = getCanonicalTrack(elementId, lockKey);

        if (!track || track.keyframes.length === 0) {
          // Static prop override
          await sendTransformPatch({ [prop]: value } as any);
          return;
        }

        const idx = track.keyframes.findIndex((k) => approxEq(k.time, position));

        if (idx >= 0) {
          const kf = track.keyframes[idx];
          lockElement(elementId, lockKey);
          try {
            const updated = await api.updateKeyframe(PROJECT_PATH, elementId, lockKey, idx, value, {
              time: position,
              keyframeId: kf.id,
              easing: track.easing,
            });
            setCanonicalAnimationsFromProject(updated);
            markLocalConflictWindow(elementId, lockKey);
          } finally {
            unlockElement(elementId, lockKey);
          }
        } else {
          // Canonical policy: for sequenced props, only add when Theatre reports
          // a keyframe was explicitly created at this position.
          if (!theatreHasKeyframeAtPosition(pointer, position)) return;
          lockElement(elementId, lockKey);
          try {
            const updated = await api.addKeyframe(PROJECT_PATH, elementId, lockKey, position, value, track.easing);
            setCanonicalAnimationsFromProject(updated);
            markLocalConflictWindow(elementId, lockKey);
          } finally {
            unlockElement(elementId, lockKey);
          }
        }
        });
      });
    };

    const handleAudioProp = (prop: 'volume' | 'start') => {
      const pointer = (obj as any).props[prop];
      return onChange(pointer, (raw) => {
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(value)) return;
        queueWrite(`wb:${elementId}:${prop}`, async () => {
          if (isElementLocked(elementId, prop)) return;
          const position = sheet.sequence.position;
          const track = getCanonicalTrack(elementId, prop);
          if (!track || track.keyframes.length === 0) {
            await sendAudioPatch({ [prop]: value } as any);
            return;
          }
          const idx = track.keyframes.findIndex((k) => approxEq(k.time, position));
          if (idx >= 0) {
            const kf = track.keyframes[idx];
            lockElement(elementId, prop);
            try {
              const updated = await api.updateKeyframe(PROJECT_PATH, elementId, prop, idx, value, {
                time: position,
                keyframeId: kf.id,
                easing: track.easing,
              });
              setCanonicalAnimationsFromProject(updated);
              markLocalConflictWindow(elementId, prop);
            } finally {
              unlockElement(elementId, prop);
            }
          } else {
            if (!theatreHasKeyframeAtPosition(pointer, position)) return;
            lockElement(elementId, prop);
            try {
              const updated = await api.addKeyframe(PROJECT_PATH, elementId, prop, position, value, track.easing);
              setCanonicalAnimationsFromProject(updated);
              markLocalConflictWindow(elementId, prop);
            } finally {
              unlockElement(elementId, prop);
            }
          }
        });
      });
    };

    const unsubs =
      elementType === 'audio'
        ? [handleAudioProp('volume'), handleAudioProp('start')]
        : [handleProp('x'), handleProp('y'), handleProp('scale'), handleProp('rotation'), handleProp('opacity')];

    const prevUnsub = r.unsubscribeValues;
    r.unsubscribeValues = () => {
      prevUnsub?.();
      for (const u of unsubs) u?.();
    };
  }
}
