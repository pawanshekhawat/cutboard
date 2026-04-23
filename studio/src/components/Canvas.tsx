import React, { useEffect, useMemo, useState } from 'react';
import type { ProjectData } from '../lib/api';
import { subscribeToTheatreElementValues } from '../lib/theatre-native';

interface CanvasProps {
  project: ProjectData | null;
  currentTime: number;
}

export const Canvas: React.FC<CanvasProps> = ({ project, currentTime }) => {
  const [liveTransforms, setLiveTransforms] = useState<
    Record<string, { x: number; y: number; scale: number; rotation: number; opacity: number }>
  >({});

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

  const canvasStyle = useMemo(() => {
    if (!project) return {};
    return {
      width: `${project.meta.resolution.width}px`,
      height: `${project.meta.resolution.height}px`,
      position: 'relative' as const,
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
      <div style={{ ...canvasStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}>
        No project loaded
      </div>
    );
  }

  return (
    <div style={canvasStyle}>
      {elements.map(el => {
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
  );
};
