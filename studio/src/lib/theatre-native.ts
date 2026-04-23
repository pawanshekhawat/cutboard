import { getProject, onChange, val } from '@theatre/core';
import studio from '@theatre/studio';
import type { ISheet, ISheetObject } from '@theatre/core';
import type { ProjectData } from './api';
import { api } from './api';
import { isElementLocked, lockElement, unlockElement } from './theatre-sync';

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';

type TheatreObjectValues = {
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
};

type ElementRuntime = {
  object: ISheetObject<TheatreObjectValues>;
  unsubscribeValues: () => void;
  lastSent?: { x: number; y: number; scale: number; rotation: number; opacity: number; at: number };
};

type Runtime = {
  sheet: ISheet;
  elements: Map<string, ElementRuntime>;
  unsubscribePosition: () => void;
};

let runtime: Runtime | null = null;

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

function approxEq(a: number, b: number, eps = 1e-4) {
  return Math.abs(a - b) < eps;
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

  // Create objects for each element.
  for (const el of Object.values(projectJson.elements)) {
    const transform = normalizeTransform(el.transform);
    const obj = sheet.object(el.id, {
      transform: {
        x: transform.x,
        y: transform.y,
        scale: transform.scale,
        rotation: transform.rotation,
        opacity: transform.opacity,
      },
    });

    // Keep default values synced from JSON when not actively editing that prop.
    obj.initialValue = { transform };

    const unsubscribeValues = obj.onValuesChange((newValues) => {
      opts.onValues?.(el.id, newValues as TheatreObjectValues);
    });

    elements.set(el.id, { object: obj, unsubscribeValues });
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
  cb: (values: TheatreObjectValues) => void
): (() => void) | null {
  const r = runtime?.elements.get(elementId);
  if (!r) return null;
  return r.object.onValuesChange((v) => cb(v as TheatreObjectValues));
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

  for (const el of Object.values(projectJson.elements)) {
    const r = runtime.elements.get(el.id);
    if (!r) continue;
    const t = normalizeTransform(el.transform);

    // If any transform prop is locked, skip applying to avoid interrupting drags.
    const locked =
      isElementLocked(el.id, 'transform.x') ||
      isElementLocked(el.id, 'transform.y') ||
      isElementLocked(el.id, 'transform.scale') ||
      isElementLocked(el.id, 'transform.rotation') ||
      isElementLocked(el.id, 'transform.opacity');
    if (locked) continue;

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

  for (const [elementId, r] of elements.entries()) {
    const obj = r.object;

    const sendTransformPatch = async (patch: Partial<TheatreObjectValues['transform']>) => {
      const keys = Object.keys(patch);
      if (keys.length === 0) return;
      // lock all touched props during write
      for (const k of keys) lockElement(elementId, `transform.${k}`);
      try {
        await api.updateElement(PROJECT_PATH, elementId, {
          transform: {
            ...(obj.value.transform as any),
            ...patch,
          },
        } as any);
      } finally {
        for (const k of keys) unlockElement(elementId, `transform.${k}`);
      }
    };

    const handleProp = (prop: keyof TheatreObjectValues['transform']) => {
      const pointer = (obj as any).props.transform[prop];

      return onChange(pointer, (raw) => {
        const value = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(value)) return;

        void (async () => {
        // Respect locks to avoid loops when applying external updates.
        const lockKey = `transform.${prop}`;
        if (isElementLocked(elementId, lockKey)) return;

        const position = sheet.sequence.position;

        // Determine whether this prop is sequenced and whether there is a keyframe at current time.
        const keyframes = (sheet.sequence as any).__experimental_getKeyframes?.(pointer) as
          | Array<{ position: number; value: number }>
          | undefined;

        if (!keyframes || keyframes.length === 0) {
          // Static prop override
          await sendTransformPatch({ [prop]: value } as any);
          return;
        }

        // Sequenced prop: find keyframe at current position (or nearest within epsilon).
        const sorted = [...keyframes].sort((a, b) => a.position - b.position);
        const idx = sorted.findIndex((k) => approxEq(k.position, position));

        if (idx >= 0) {
          // Update existing keyframe value (and time for safety)
          lockElement(elementId, lockKey);
          try {
            await api.updateKeyframe(PROJECT_PATH, elementId, `transform.${prop}`, idx, value, { time: position });
          } finally {
            unlockElement(elementId, lockKey);
          }
        } else {
          // Add new keyframe at current position
          lockElement(elementId, lockKey);
          try {
            await api.addKeyframe(PROJECT_PATH, elementId, `transform.${prop}`, position, value);
          } finally {
            unlockElement(elementId, lockKey);
          }
        }
        })();
      });
    };

    // Subscribe to each transform prop pointer
    const unsubs = [
      handleProp('x'),
      handleProp('y'),
      handleProp('scale'),
      handleProp('rotation'),
      handleProp('opacity'),
    ];

    const prevUnsub = r.unsubscribeValues;
    r.unsubscribeValues = () => {
      prevUnsub?.();
      for (const u of unsubs) u?.();
    };
  }
}

