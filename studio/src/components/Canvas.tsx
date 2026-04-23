import React, { useMemo } from 'react';
import type { ProjectData } from '../lib/api';

interface CanvasProps {
  project: ProjectData | null;
  currentTime: number;
}

export const Canvas: React.FC<CanvasProps> = ({ project, currentTime }) => {
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

  const computeValueAtTime = (element: ProjectData['elements'][string], time: number) => {
    const base = element.transform;
    const result = { ...base };

    if (!project?.animations) return result;

    // Group animations by target element
    const elementAnimations = Object.values(project.animations)
      .filter(anim => anim.target === element.id);

    for (const anim of elementAnimations) {
      const { property, keyframes } = anim;
      
      if (keyframes.length === 0) continue;

      // Find surrounding keyframes
      let before = keyframes[0];
      let after = keyframes[keyframes.length - 1];

      for (let i = 0; i < keyframes.length - 1; i++) {
        if (time >= keyframes[i].time && time <= keyframes[i + 1].time) {
          before = keyframes[i];
          after = keyframes[i + 1];
          break;
        }
      }

      // Linear interpolation
      const t = before.time === after.time 
        ? 0 
        : (time - before.time) / (after.time - before.time);
      const value = before.value + (after.value - before.value) * t;

      // Apply to result
      const [target, prop] = property.split('.');
      if (target === 'transform' && prop) {
        (result as any)[prop] = value;
      }
    }

    return result;
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
        const transform = computeValueAtTime(el, currentTime);
        
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
