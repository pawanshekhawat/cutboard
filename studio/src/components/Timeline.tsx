import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AddElementPayload, ProjectData } from '../lib/api';
import { api } from '../lib/api';
import { PROJECT_PATH } from '../lib/config';
import { lockElement, unlockElement } from '../lib/theatre-sync';

type TrimSide = 'left' | 'right';
type PendingTimingPatch = Partial<Pick<
  ProjectData['elements'][string],
  'start' | 'duration' | 'trimStart' | 'trimDuration'
>>;

type DragState = {
  elementId: string;
  side: TrimSide;
  startClientX: number;
  timelineLeft: number;
  pixelsPerSecond: number;
  // baseline element values
  oldStart: number;
  oldDuration: number;
  oldTrimStart: number;
  oldTrimDuration: number;
  minDuration: number;
  assetDuration?: number;
};

type MoveDragState = {
  elementId: string;
  startClientX: number;
  pixelsPerSecond: number;
  oldStart: number;
};

type AssetDragPayload = {
  assetId: string;
  type: 'video' | 'image' | 'audio' | 'composition';
  src?: string;
};

type TrackDragState = {
  fromIndex: number;
};

interface TimelineProps {
  project: ProjectData | null;
  currentTime: number;
  onTimeChange: (time: number) => void;
  onPlayPause: () => void;
  isPlaying: boolean;
  onProjectRefresh?: () => Promise<void> | void;
}

export const Timeline: React.FC<TimelineProps> = ({
  project,
  currentTime,
  onTimeChange,
  onPlayPause,
  isPlaying,
  onProjectRefresh
}) => {
  if (!project) return null;

  const duration = project.meta.duration;
  const fps = Number(project.meta.fps) || 30;
  const minDuration = fps > 0 ? 1 / fps : 0.01;
  const trackCount = project.tracks.length > 0 ? project.tracks.length : Object.values(project.elements).length;
  const trackHeight = 30;
  const rulerHeight = 20;
  const timelineInnerHeight = Math.max(60, rulerHeight + trackCount * trackHeight);
  const timelineViewportHeight = Math.min(260, timelineInnerHeight);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const moveDragRef = useRef<MoveDragState | null>(null);
  const [pendingEdits, setPendingEdits] = useState<Record<string, PendingTimingPatch>>({});
  const pendingEditsRef = useRef<Record<string, PendingTimingPatch>>({});
  const [isDropOver, setIsDropOver] = useState(false);
  const trackDragRef = useRef<TrackDragState | null>(null);
  const [trackDropIndex, setTrackDropIndex] = useState<number | null>(null);

  const getElementWithPending = (elementId: string) => {
    const base = project.elements[elementId];
    if (!base) return null;
    const patch = pendingEdits[elementId];
    return patch ? ({ ...base, ...patch } as ProjectData['elements'][string]) : base;
  };

  const getAssetDuration = (element: ProjectData['elements'][string]): number | undefined => {
    const assetId = (element as any).assetId as string | undefined;
    if (!assetId) return undefined;
    const d = (project.assets as any)?.[assetId]?.duration;
    const n = typeof d === 'number' ? d : Number(d);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const waveformCacheRef = useRef<Record<string, number[]>>({});
  const waveformInflightRef = useRef<Record<string, Promise<number[]>>>({});

  const AudioWaveform: React.FC<{ element: ProjectData['elements'][string] }> = ({ element }) => {
    const [peaks, setPeaks] = useState<number[] | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [hasError, setHasError] = useState(false);

    const assetDuration = useMemo(() => {
      const asset = element.assetId ? project.assets[element.assetId] : undefined;
      const d = Number(asset?.duration);
      if (Number.isFinite(d) && d > 0) return d;
      const trimStart = Math.max(Number((element as any).trimStart) || 0, 0);
      return trimStart + Math.max(Number(element.duration) || 0, minDuration);
    }, [element]);

    const trimStart = Math.max(Number((element as any).trimStart) || 0, 0);
    const clipDuration = Math.max(Number(element.duration) || 0, minDuration);

    useEffect(() => {
      let cancelled = false;
      const cacheKey = `${element.assetId || ''}:512`;
      const cached = waveformCacheRef.current[cacheKey];
      if (cached) {
        setPeaks(cached);
        return;
      }

      const load = async () => {
        if (!element.assetId) return;
        setIsLoading(true);
        setHasError(false);
        try {
          let inflight = waveformInflightRef.current[cacheKey];
          if (!inflight) {
            inflight = api
              .getAudioWaveform(PROJECT_PATH, { assetId: element.assetId, samples: 512 })
              .then((res) => res.peaks || [])
              .finally(() => {
                delete waveformInflightRef.current[cacheKey];
              });
            waveformInflightRef.current[cacheKey] = inflight;
          }
          const sharedPeaks = await inflight;
          if (cancelled) return;
          waveformCacheRef.current[cacheKey] = sharedPeaks;
          setPeaks(sharedPeaks);
        } catch {
          if (cancelled) return;
          setHasError(true);
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [element.assetId]);

    const sourceDuration = useMemo(() => Math.max(assetDuration, clipDuration), [assetDuration, clipDuration]);

    const waveformPaths = useMemo(() => {
      if (!peaks || peaks.length === 0) return null;
      if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return null;

      // Build waveform in source-time coordinates so trimming is a moving window,
      // not a stretch/squish transform of a pre-windowed path.
      const top = peaks
        .map((p, i) => {
          const t = peaks.length > 1 ? (i / (peaks.length - 1)) * sourceDuration : 0;
          const y = 50 - clamp(p, 0, 1) * 45;
          return `${t},${y}`;
        })
        .join(' ');

      const bottom = peaks
        .map((p, i) => {
          const t = peaks.length > 1 ? (i / (peaks.length - 1)) * sourceDuration : 0;
          const y = 50 + clamp(p, 0, 1) * 45;
          return `${t},${y}`;
        })
        .join(' ');

      return { top, bottom };
    }, [peaks, sourceDuration]);

    if (isLoading && !peaks) {
      return <div style={{ position: 'absolute', inset: '2px 10px', opacity: 0.25, fontSize: '10px' }}>loading waveform...</div>;
    }
    if (hasError && !peaks) return null;
    if (!waveformPaths) return null;

    const viewStart = clamp(trimStart, 0, Math.max(sourceDuration - minDuration, 0));
    const viewWidth = clamp(clipDuration, minDuration, Math.max(sourceDuration - viewStart, minDuration));

    return (
      <svg
        viewBox={`${viewStart} 0 ${viewWidth} 100`}
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          left: 8,
          right: 8,
          top: 4,
          bottom: 4,
          width: 'calc(100% - 16px)',
          height: 'calc(100% - 8px)',
          opacity: 0.75,
          pointerEvents: 'none',
        }}
      >
        <polyline points={waveformPaths.top} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="0.08" />
        <polyline
          points={waveformPaths.bottom}
          fill="none"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="0.06"
        />
      </svg>
    );
  };

  const computePatch = (
    el: ProjectData['elements'][string],
    side: TrimSide,
    deltaSecondsRaw: number
  ): PendingTimingPatch => {
    const oldStart = Number(el.start) || 0;
    const oldDuration = Math.max(Number(el.duration) || 0, minDuration);
    const oldTrimStart = Math.max(Number((el as any).trimStart) || 0, 0);
    const oldTrimDuration = Math.max(
      Number((el as any).trimDuration) || oldDuration,
      minDuration
    );

    const assetDuration = getAssetDuration(el);

    // Clamp delta so we never violate timeline minimums.
    let delta = deltaSecondsRaw;

    // Text clips do not have trim semantics; left/right drags only affect start/duration.
    if (el.type === 'text') {
      if (side === 'left') {
        delta = Math.max(delta, -oldStart);
        delta = Math.min(delta, oldDuration - minDuration);
        return {
          start: clamp(oldStart + delta, 0, Number.POSITIVE_INFINITY),
          duration: Math.max(oldDuration - delta, minDuration),
        };
      }
      // right
      delta = Math.max(delta, minDuration - oldDuration);
      return {
        duration: Math.max(oldDuration + delta, minDuration),
      };
    }

    if (side === 'left') {
      // NLE behavior: left trim moves timeline start forward/back and shifts source in-point by same delta.
      delta = Math.max(delta, -oldStart);
      delta = Math.min(delta, oldDuration - minDuration);
      delta = Math.max(delta, -oldTrimStart);
      if (assetDuration !== undefined) {
        delta = Math.min(delta, Math.max(assetDuration - oldTrimStart - minDuration, 0));
      }

      const newStart = oldStart + delta;
      const newDuration = oldDuration - delta;
      const newTrimStart = oldTrimStart + delta;
      const patch: PendingTimingPatch = {
        start: clamp(newStart, 0, Number.POSITIVE_INFINITY),
        duration: Math.max(newDuration, minDuration),
        trimStart: Math.max(newTrimStart, 0),
      };

      if (el.type === 'video' || el.type === 'composition') {
        patch.trimDuration = Math.max(oldTrimDuration - delta, minDuration);
      }

      return patch;
    }

    // right
    // duration cannot go below minDuration
    delta = Math.max(delta, minDuration - oldDuration);

    if (assetDuration !== undefined) {
      // newTrimStart + newTrimDuration <= assetDuration
      const maxTrimDuration = assetDuration - oldTrimStart;
      const targetTrimDuration = oldTrimDuration + delta;
      const clampedTrimDuration = clamp(targetTrimDuration, minDuration, Math.max(maxTrimDuration, minDuration));
      // Keep duration and trimDuration in sync for video-like elements.
      const newDuration = clamp(oldDuration + delta, minDuration, clampedTrimDuration);
      return {
        duration: Math.max(newDuration, minDuration),
        trimDuration: clampedTrimDuration,
      };
    }

    return {
      duration: Math.max(oldDuration + delta, minDuration),
      trimDuration: Math.max(oldTrimDuration + delta, minDuration),
    };
  };

  const startTrimDrag = (e: React.PointerEvent, elementId: string, side: TrimSide) => {
    const element = getElementWithPending(elementId) ?? project.elements[elementId];
    if (!element) return;

    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const widthPx = Math.max(1, rect.width);
    const pixelsPerSecond = widthPx / Math.max(duration, minDuration);

    const oldStart = Number(element.start) || 0;
    const oldDuration = Math.max(Number(element.duration) || 0, minDuration);
    const oldTrimStart = Math.max(Number((element as any).trimStart) || 0, 0);
    const oldTrimDuration = Math.max(Number((element as any).trimDuration) || oldDuration, minDuration);

    const assetDuration = getAssetDuration(element);

    dragRef.current = {
      elementId,
      side,
      startClientX: e.clientX,
      timelineLeft: rect.left,
      pixelsPerSecond,
      oldStart,
      oldDuration,
      oldTrimStart,
      oldTrimDuration,
      minDuration,
      assetDuration,
    };

    (e.currentTarget as any).setPointerCapture?.(e.pointerId);

    const handleMove = (ev: PointerEvent) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startClientX;
      const deltaSeconds = dx / s.pixelsPerSecond;
      const baseEl = project.elements[s.elementId];
      if (!baseEl) return;
      const patch = computePatch(baseEl, s.side, deltaSeconds);
      setPendingEdits((prev) => {
        const next = { ...prev, [s.elementId]: patch };
        pendingEditsRef.current = next;
        return next;
      });
    };

    const handleUp = async () => {
      const s = dragRef.current;
      dragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      if (!s) return;

      const patch = pendingEditsRef.current[s.elementId];
      if (!patch) return;

      // Persist a single update.
      const lockKeys = ['start', 'duration', 'trimStart', 'trimDuration'];
      for (const k of lockKeys) lockElement(s.elementId, k);
      try {
        // Only write fields that exist/relevant for element type.
        const el = project.elements[s.elementId];
        if (!el) return;
        const updates: any = {};
        if (typeof patch.start === 'number') updates.start = patch.start;
        if (typeof patch.duration === 'number') updates.duration = patch.duration;

        // Only apply trim fields to video-like + audio if present.
        if (el.type === 'video' || el.type === 'composition' || el.type === 'audio') {
          if (typeof patch.trimStart === 'number') updates.trimStart = patch.trimStart;
          // Audio schema does not necessarily use trimDuration, but writing it is harmless.
          if (typeof patch.trimDuration === 'number' && (el.type === 'video' || el.type === 'composition')) {
            updates.trimDuration = patch.trimDuration;
          }
        }

        await api.updateElement(PROJECT_PATH, s.elementId, updates);
        // Force local state re-sync right after successful persist so UI does not
        // depend solely on SSE timing to reflect trim changes.
        await Promise.resolve(onProjectRefresh?.());
      } catch (err: any) {
        console.error('Trim persist failed:', err);
      } finally {
        for (const k of lockKeys) unlockElement(s.elementId, k);
        setPendingEdits((prev) => {
          const next = { ...prev };
          delete next[s.elementId];
          pendingEditsRef.current = next;
          return next;
        });
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  };

  const startBodyDrag = (e: React.PointerEvent, elementId: string) => {
    const element = getElementWithPending(elementId) ?? project.elements[elementId];
    if (!element) return;
    if (!timelineRef.current) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const widthPx = Math.max(1, rect.width);
    const pixelsPerSecond = widthPx / Math.max(duration, minDuration);
    const oldStart = Number(element.start) || 0;

    moveDragRef.current = {
      elementId,
      startClientX: e.clientX,
      pixelsPerSecond,
      oldStart,
    };

    (e.currentTarget as any).setPointerCapture?.(e.pointerId);

    const handleMove = (ev: PointerEvent) => {
      const s = moveDragRef.current;
      if (!s) return;
      const dx = ev.clientX - s.startClientX;
      const deltaSeconds = dx / s.pixelsPerSecond;
      const newStart = Math.max(0, s.oldStart + deltaSeconds);
      const patch: PendingTimingPatch = { start: newStart };
      setPendingEdits((prev) => {
        const next = { ...prev, [s.elementId]: { ...prev[s.elementId], ...patch } };
        pendingEditsRef.current = next;
        return next;
      });
    };

    const handleUp = async () => {
      const s = moveDragRef.current;
      moveDragRef.current = null;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      if (!s) return;

      const patch = pendingEditsRef.current[s.elementId];
      if (!patch || typeof patch.start !== 'number') return;

      lockElement(s.elementId, 'start');
      try {
        await api.updateElement(PROJECT_PATH, s.elementId, { start: patch.start });
        await Promise.resolve(onProjectRefresh?.());
      } catch (err: any) {
        console.error('Clip move persist failed:', err);
      } finally {
        unlockElement(s.elementId, 'start');
        setPendingEdits((prev) => {
          const next = { ...prev };
          delete next[s.elementId];
          pendingEditsRef.current = next;
          return next;
        });
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const createElementFromAsset = (
    asset: AssetDragPayload,
    start: number
  ): AddElementPayload => {
    const assetMeta = project.assets?.[asset.assetId];
    const fallbackDuration = 5;
    const safeDuration = Math.max(
      minDuration,
      Number.isFinite(Number(assetMeta?.duration)) && Number(assetMeta?.duration) > 0
        ? Number(assetMeta?.duration)
        : fallbackDuration
    );
    const id = `el_${asset.type}_${Math.random().toString(36).slice(2, 8)}`;
    const base = {
      id,
      start,
      duration: safeDuration,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    };

    if (asset.type === 'video') {
      return {
        ...base,
        type: 'video',
        assetId: asset.assetId,
        trimStart: 0,
        trimDuration: safeDuration,
      };
    }
    if (asset.type === 'audio') {
      return {
        ...base,
        type: 'audio',
        assetId: asset.assetId,
        trimStart: 0,
        volume: 1,
      };
    }
    if (asset.type === 'composition') {
      return {
        ...base,
        type: 'composition',
        assetId: asset.assetId,
        trimStart: 0,
        trimDuration: safeDuration,
      };
    }
    return {
      ...base,
      type: 'image',
      assetId: asset.assetId,
    };
  };

  const persistProject = async (nextProject: ProjectData) => {
    await api.saveProject(PROJECT_PATH, nextProject);
    await Promise.resolve(onProjectRefresh?.());
  };

  const reorderTracksAndElements = async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (!project.tracks || project.tracks.length < 2) return;

    const tracks = [...project.tracks];
    const [moved] = tracks.splice(fromIndex, 1);
    tracks.splice(toIndex, 0, moved);

    const existingElements = project.elements || {};
    const orderedIds: string[] = [];
    for (const track of tracks) {
      for (const id of track.elements || []) {
        if (!orderedIds.includes(id) && existingElements[id]) orderedIds.push(id);
      }
    }
    for (const id of Object.keys(existingElements)) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }

    const reorderedElements: ProjectData['elements'] = {};
    for (const id of orderedIds) {
      const el = existingElements[id];
      if (el) reorderedElements[id] = el;
    }

    const nextProject: ProjectData = {
      ...project,
      tracks: tracks as any,
      elements: reorderedElements,
    };
    await persistProject(nextProject);
  };

  const handleAssetDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropOver(false);
    if (!timelineRef.current) return;

    const raw = event.dataTransfer.getData('application/x-cutboard-asset');
    if (!raw) return;

    let payload: AssetDragPayload | null = null;
    try {
      payload = JSON.parse(raw) as AssetDragPayload;
    } catch {
      payload = null;
    }
    if (!payload?.assetId || !payload?.type) return;

    const rect = timelineRef.current.getBoundingClientRect();
    const clampedX = clamp(event.clientX - rect.left, 0, rect.width);
    const start = clamp((clampedX / Math.max(rect.width, 1)) * duration, 0, Number.POSITIVE_INFINITY);

    const yInTracks = event.clientY - rect.top - rulerHeight;
    const targetTrackIndex = clamp(Math.floor(yInTracks / trackHeight), 0, Math.max(trackCount - 1, 0));

    try {
      const element = createElementFromAsset(payload, start);
      const nextProject: ProjectData = JSON.parse(JSON.stringify(project));
      if (!nextProject.elements || typeof nextProject.elements !== 'object') nextProject.elements = {} as any;
      nextProject.elements[element.id] = element as any;

      if (!Array.isArray(nextProject.tracks)) nextProject.tracks = [] as any;
      const preferredTrack = nextProject.tracks[targetTrackIndex];
      if (preferredTrack) {
        preferredTrack.elements = Array.isArray(preferredTrack.elements) ? preferredTrack.elements : [];
        preferredTrack.elements.push(element.id);
      } else {
        nextProject.tracks.push({
          id: `track_${payload.type}_${Math.random().toString(36).slice(2, 6)}`,
          type: payload.type === 'audio' ? 'audio' : 'video',
          elements: [element.id],
        } as any);
      }

      await persistProject(nextProject);
    } catch (err) {
      console.error('Failed to add dropped asset to timeline:', err);
    }
  };

  return (
    <div style={{ padding: '20px', backgroundColor: '#1a1a1a', color: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '20px' }}>
        <button
          onClick={onPlayPause}
          style={{
            padding: '10px 20px',
            backgroundColor: isPlaying ? '#e74c3c' : '#2ecc71',
            border: 'none',
            borderRadius: '4px',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '16px'
          }}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        
        <span style={{ fontFamily: 'monospace', fontSize: '18px' }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!event.dataTransfer.types.includes('application/x-cutboard-asset')) return;
          event.dataTransfer.dropEffect = 'copy';
          setIsDropOver(true);
        }}
        onDragLeave={() => setIsDropOver(false)}
        onDrop={handleAssetDrop}
        style={{
          maxHeight: `${timelineViewportHeight}px`,
          overflowY: 'auto',
          backgroundColor: isDropOver ? '#34495e' : '#2a2a2a',
          borderRadius: '4px',
          transition: 'background-color 120ms ease',
        }}
      >
        <div ref={timelineRef} style={{ position: 'relative', height: `${timelineInnerHeight}px` }}>
          {/* Time ruler */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: `${rulerHeight}px`,
            borderBottom: '1px solid #444'
          }}>
            {Array.from({ length: Math.ceil(duration) + 1 }).map((_, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${(i / duration) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  backgroundColor: '#444'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '2px',
                  left: '4px',
                  fontSize: '10px',
                  color: '#888'
                }}>
                  {formatTime(i)}
                </span>
              </div>
            ))}
          </div>

          {/* Track visualization */}
          <div style={{ position: 'absolute', top: `${rulerHeight}px`, left: 0, right: 0, height: `${trackCount * trackHeight}px` }}>
            {project.tracks.length > 0 ? (
              project.tracks.map((track, trackIndex) => (
                <div
                  key={track.id}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('application/x-cutboard-track')) return;
                    e.preventDefault();
                    setTrackDropIndex(trackIndex);
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes('application/x-cutboard-track')) return;
                    e.preventDefault();
                    const drag = trackDragRef.current;
                    trackDragRef.current = null;
                    setTrackDropIndex(null);
                    if (!drag) return;
                    void reorderTracksAndElements(drag.fromIndex, trackIndex);
                  }}
                  style={{
                    position: 'absolute',
                    top: `${trackIndex * trackHeight}px`,
                    left: 0,
                    right: 0,
                    height: '28px',
                    backgroundColor: trackDropIndex === trackIndex ? '#3d4f62' : '#333',
                    marginBottom: '2px'
                  }}
                >
                  <div
                    draggable
                    onDragStart={(e) => {
                      trackDragRef.current = { fromIndex: trackIndex };
                      e.dataTransfer.setData('application/x-cutboard-track', String(trackIndex));
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      trackDragRef.current = null;
                      setTrackDropIndex(null);
                    }}
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: '22px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#bbb',
                      cursor: 'grab',
                      background: 'rgba(0,0,0,0.18)',
                      zIndex: 4,
                      userSelect: 'none',
                    }}
                    title="Drag to reorder track"
                  >
                    ::
                  </div>
                  {track.elements.map(elementId => {
                    const element = getElementWithPending(elementId);
                    if (!element) return null;
                    const isLeftTrimmable = element.type === 'video' || element.type === 'audio' || element.type === 'composition' || element.type === 'text';
                    const isRightTrimmable = isLeftTrimmable || element.type === 'text';

                    return (
                      <div
                        key={element.id}
                        onPointerDown={(e) => startBodyDrag(e, element.id)}
                        style={{
                          position: 'absolute',
                          left: `${(element.start / duration) * 100}%`,
                          width: `${(element.duration / duration) * 100}%`,
                          height: '100%',
                          backgroundColor: element.type === 'text' ? '#3498db' : 
                                          element.type === 'video' ? '#e74c3c' : 
                                          element.type === 'image' ? '#f39c12' :
                                          element.type === 'composition' ? '#1abc9c' : '#9b59b6',
                          borderRadius: '4px',
                          padding: '4px 8px',
                          fontSize: '12px',
                          color: '#fff',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          cursor: 'grab',
                          zIndex: 1
                        }}
                      >
                        {(isLeftTrimmable || isRightTrimmable) && (
                          <>
                            {isLeftTrimmable && (
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  startTrimDrag(e, element.id, 'left');
                                }}
                                style={{
                                  position: 'absolute',
                                  left: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: '8px',
                                  cursor: 'ew-resize',
                                  background: 'rgba(0,0,0,0.25)',
                                }}
                                onClick={(ev) => ev.stopPropagation()}
                              />
                            )}
                            {isRightTrimmable && (
                              <div
                                onPointerDown={(e) => {
                                  e.stopPropagation();
                                  startTrimDrag(e, element.id, 'right');
                                }}
                                style={{
                                  position: 'absolute',
                                  right: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: '8px',
                                  cursor: 'ew-resize',
                                  background: 'rgba(0,0,0,0.25)',
                                }}
                                onClick={(ev) => ev.stopPropagation()}
                              />
                            )}
                          </>
                        )}
                        {element.type === 'text'
                          ? element.content
                          : element.type === 'composition'
                            ? `comp: ${(element.assetId || '').split('/').pop()}`
                            : element.assetId?.split('/').pop()}
                        {element.type === 'audio' && <AudioWaveform element={element} />}
                      </div>
                    );
                  })}
                </div>
              ))
            ) : (
              // Fallback: show all elements as tracks if no tracks defined
              Object.values(project.elements).map((element, idx) => (
                <div
                  key={element.id}
                  style={{
                    position: 'absolute',
                    top: `${idx * trackHeight}px`,
                    left: 0,
                    right: 0,
                    height: '28px',
                    backgroundColor: '#333',
                    marginBottom: '2px'
                  }}
                >
                  {(() => {
                    const merged = getElementWithPending(element.id) ?? element;
                    const isLeftTrimmable = merged.type === 'video' || merged.type === 'audio' || merged.type === 'composition' || merged.type === 'text';
                    const isRightTrimmable = isLeftTrimmable || merged.type === 'text';
                    return (
                  <div
                    onPointerDown={(e) => startBodyDrag(e, merged.id)}
                    style={{
                      position: 'absolute',
                      left: `${(merged.start / duration) * 100}%`,
                      width: `${(merged.duration / duration) * 100}%`,
                      height: '100%',
                      backgroundColor: merged.type === 'text' ? '#3498db' : 
                                      merged.type === 'video' ? '#e74c3c' : 
                                      merged.type === 'image' ? '#f39c12' :
                                      merged.type === 'composition' ? '#1abc9c' : '#9b59b6',
                      borderRadius: '4px',
                      padding: '4px 8px',
                      fontSize: '12px',
                      color: '#fff',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      cursor: 'grab'
                    }}
                  >
                    {(isLeftTrimmable || isRightTrimmable) && (
                      <>
                        {isLeftTrimmable && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startTrimDrag(e, merged.id, 'left');
                            }}
                            style={{
                              position: 'absolute',
                              left: 0,
                              top: 0,
                              bottom: 0,
                              width: '8px',
                              cursor: 'ew-resize',
                              background: 'rgba(0,0,0,0.25)',
                            }}
                            onClick={(ev) => ev.stopPropagation()}
                          />
                        )}
                        {isRightTrimmable && (
                          <div
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startTrimDrag(e, merged.id, 'right');
                            }}
                            style={{
                              position: 'absolute',
                              right: 0,
                              top: 0,
                              bottom: 0,
                              width: '8px',
                              cursor: 'ew-resize',
                              background: 'rgba(0,0,0,0.25)',
                            }}
                            onClick={(ev) => ev.stopPropagation()}
                          />
                        )}
                      </>
                    )}
                    {merged.type === 'text'
                      ? merged.content
                      : merged.type === 'composition'
                        ? `comp: ${(merged.assetId || '').split('/').pop()}`
                        : merged.assetId?.split('/').pop()}
                    {merged.type === 'audio' && <AudioWaveform element={merged} />}
                  </div>
                    );
                  })()}
                </div>
              ))
            )}
          </div>

          {/* Playhead */}
          <div
            style={{
              position: 'absolute',
              left: `${(currentTime / duration) * 100}%`,
              top: 0,
              bottom: 0,
              width: '2px',
              backgroundColor: '#e74c3c',
              cursor: 'ew-resize',
              zIndex: 10
            }}
            onMouseDown={(e) => {
              const rect = e.currentTarget.parentElement?.getBoundingClientRect();
              if (!rect) return;

              const handleMove = (moveEvent: MouseEvent) => {
                const x = moveEvent.clientX - rect.left;
                const percent = Math.max(0, Math.min(1, x / rect.width));
                onTimeChange(percent * duration);
              };

              const handleUp = () => {
                document.removeEventListener('mousemove', handleMove);
                document.removeEventListener('mouseup', handleUp);
              };

              document.addEventListener('mousemove', handleMove);
              document.addEventListener('mouseup', handleUp);
            }}
          >
            <div style={{
              position: 'absolute',
              top: '-5px',
              left: '-5px',
              width: '12px',
              height: '12px',
              backgroundColor: '#e74c3c',
              borderRadius: '50%'
            }} />
          </div>
        </div>
      </div>
    </div>
  );
};
