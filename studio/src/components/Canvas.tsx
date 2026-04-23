import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectData } from '../lib/api';
import { subscribeToTheatreElementValues } from '../lib/theatre-native';

interface CanvasProps {
  project: ProjectData | null;
  currentTime: number;
  isProxyMode: boolean;
}

export const Canvas: React.FC<CanvasProps> = ({ project, currentTime, isProxyMode }) => {
  const [liveTransforms, setLiveTransforms] = useState<
    Record<string, { x: number; y: number; scale: number; rotation: number; opacity: number }>
  >({});
  const [debouncedTime, setDebouncedTime] = useState(currentTime);
  const [proxyImageUrl, setProxyImageUrl] = useState<string | null>(null);
  const [isProxyLoading, setIsProxyLoading] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });

  // Subscribe to Theatre object values so React re-renders live while dragging/scrubbing.
  useEffect(() => {
    if (!project) return;

    const unsubs: Array<() => void> = [];
    for (const el of Object.values(project.elements)) {
      const unsub = subscribeToTheatreElementValues(el.id, (vals) => {
        const t = vals?.transform as any;
        if (!t) return;
        setLiveTransforms((prev) => ({
          ...prev,
          [el.id]: {
            x: typeof t.x === 'number' ? t.x : 0,
            y: typeof t.y === 'number' ? t.y : 0,
            scale: typeof t.scale === 'number' ? t.scale : 1,
            rotation: typeof t.rotation === 'number' ? t.rotation : 0,
            opacity: typeof t.opacity === 'number' ? t.opacity : 1,
          },
        }));
      });
      if (unsub) unsubs.push(unsub);
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [project]);

  // Track available frame size and compute a scale that preserves project resolution ratio.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setFrameSize({ width: r.width, height: r.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Debounce timeline scrubbing so we don't spam the backend frame endpoint.
  useEffect(() => {
    if (!isProxyMode) return;
    const id = window.setTimeout(() => {
      setDebouncedTime(currentTime);
    }, 300);
    return () => window.clearTimeout(id);
  }, [currentTime, isProxyMode]);

  // Fetch FFmpeg proxy frame when proxy mode is enabled and debounced time changes.
  useEffect(() => {
    if (!project || !isProxyMode) return;
    const controller = new AbortController();
    let localUrl: string | null = null;

    const load = async () => {
      try {
        setIsProxyLoading(true);
        setProxyError(null);
        const res = await fetch(`http://localhost:3001/api/project/frame?time=${encodeURIComponent(debouncedTime)}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Proxy frame failed: ${res.status} ${txt}`);
        }
        const blob = await res.blob();
        localUrl = URL.createObjectURL(blob);
        setProxyImageUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return localUrl!;
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setProxyError(err?.message || 'Failed to load proxy frame');
      } finally {
        setIsProxyLoading(false);
      }
    };

    void load();

    return () => {
      controller.abort();
      // localUrl is revoked when replaced; here only revoke if request completed
      // after effect invalidation and wasn't committed into state.
      if (localUrl && localUrl !== proxyImageUrl) URL.revokeObjectURL(localUrl);
    };
  }, [project, isProxyMode, debouncedTime]);

  const canvasStyle = useMemo(() => {
    if (!project) return {};
    return {
      position: 'absolute' as const,
      left: 0,
      top: 0,
      width: `${project.meta.resolution.width}px`,
      height: `${project.meta.resolution.height}px`,
      backgroundColor: '#000',
      overflow: 'hidden'
    };
  }, [project]);

  const elements = useMemo(() => {
    if (!project) return [];
    return Object.values(project.elements).filter(el => 
      currentTime >= el.start && currentTime < el.start + el.duration
    );
  }, [project, currentTime]);

  const visualElements = useMemo(
    () => elements.filter((el) => el.type !== 'audio'),
    [elements]
  );

  const computeTransform = (element: ProjectData['elements'][string]) => {
    // Theatre subscription (preferred): React state drives DOM updates.
    const live = liveTransforms[element.id];
    if (live) return live;

    // Fallback: use base transform from project.json (no interpolation).
    const base: any = element.transform ?? {};
    return {
      x: typeof base.x === 'number' ? base.x : 0,
      y: typeof base.y === 'number' ? base.y : 0,
      scale: typeof base.scale === 'number' ? base.scale : 1,
      rotation: typeof base.rotation === 'number' ? base.rotation : 0,
      opacity: typeof base.opacity === 'number' ? base.opacity : 1,
    };
  };

  if (!project) {
    return (
      <div style={{ width: '100%', maxWidth: '100%', aspectRatio: '16 / 9', background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        No project loaded
      </div>
    );
  }

  const nativeW = project.meta.resolution.width || 1920;
  const nativeH = project.meta.resolution.height || 1080;
  const aspectRatio = `${nativeW} / ${nativeH}`;
  const sx = frameSize.width > 0 ? frameSize.width / nativeW : 1;
  const sy = frameSize.height > 0 ? frameSize.height / nativeH : 1;
  const stageScale = Math.min(sx, sy);
  const scaledW = nativeW * stageScale;
  const scaledH = nativeH * stageScale;

  return (
    <div
      ref={frameRef}
      style={{
        width: '100%',
        maxWidth: '100%',
        aspectRatio,
        maxHeight: 'calc(100vh - 260px)',
        margin: '0 auto',
        position: 'relative',
        background: '#000',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Status badge */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          background: 'rgba(0,0,0,0.6)',
          padding: '6px 10px',
          borderRadius: '6px',
          color: '#fff',
          fontSize: '12px',
        }}
      >
        <span>{isProxyMode ? 'Proxy' : 'DOM'}</span>
        {isProxyMode && (
          <span style={{ color: '#aaa' }}>
            t={debouncedTime.toFixed(2)}s{isProxyLoading ? ' • loading...' : ''}
          </span>
        )}
      </div>

      {isProxyMode ? (
        <div style={{ position: 'absolute', inset: 0 }}>
          {proxyImageUrl ? (
            <img
              src={proxyImageUrl}
              alt="Proxy frame preview"
              style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
            />
          ) : (
            <div style={{ color: '#aaa', fontSize: '14px', padding: '20px' }}>
              {isProxyLoading ? 'Loading proxy frame...' : 'Proxy frame unavailable'}
            </div>
          )}
          {proxyError && (
            <div
              style={{
                position: 'absolute',
                bottom: 10,
                left: 10,
                right: 10,
                color: '#ff8a8a',
                background: 'rgba(0,0,0,0.6)',
                padding: '8px',
                borderRadius: '6px',
                fontSize: '12px',
              }}
            >
              {proxyError}
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            position: 'relative',
            width: `${scaledW}px`,
            height: `${scaledH}px`,
          }}
        >
          <div
            style={{
              ...canvasStyle,
              transformOrigin: 'top left',
              transform: `scale(${stageScale})`,
            }}
          >
            {visualElements.map(el => {
              const transform = computeTransform(el);
              
              const style: React.CSSProperties = {
                position: 'absolute',
                left: `${transform.x}px`,
                top: `${transform.y}px`,
                transform: `translate(-50%, -50%) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
                opacity: transform.opacity,
                color: el.type === 'text' ? el.style?.color || '#fff' : undefined,
                fontSize: el.type === 'text' ? `${el.style?.fontSize || 48}px` : undefined,
                fontFamily: el.type === 'text' ? el.style?.fontFamily || 'Arial' : undefined,
                whiteSpace: 'nowrap',
                pointerEvents: 'none'
              };

              if (el.type === 'text') {
                return (
                  <div key={el.id} style={style}>
                    {el.content}
                  </div>
                );
              }

              if (el.type === 'image' && el.assetId) {
                return (
                  <img
                    key={el.id}
                    src={`http://localhost:3001/${el.assetId}`}
                    alt=""
                    style={{ ...style, maxWidth: '100%', maxHeight: '100%' }}
                  />
                );
              }

              if (el.type === 'video' && el.assetId) {
                return (
                  <video
                    key={el.id}
                    src={`http://localhost:3001/${el.assetId}`}
                    style={{ ...style, maxWidth: '100%', maxHeight: '100%' }}
                    muted
                    loop
                    autoPlay
                  />
                );
              }

              return null;
            })}
          </div>
        </div>
      )}
    </div>
  );
};
