import React from 'react';
import type { ProjectData } from '../lib/api';

interface TimelineProps {
  project: ProjectData | null;
  currentTime: number;
  onTimeChange: (time: number) => void;
  onPlayPause: () => void;
  isPlaying: boolean;
}

export const Timeline: React.FC<TimelineProps> = ({
  project,
  currentTime,
  onTimeChange,
  onPlayPause,
  isPlaying
}) => {
  if (!project) return null;

  const duration = project.meta.duration;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
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

      <div style={{ position: 'relative', height: '60px', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
        {/* Time ruler */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '20px',
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
        <div style={{ position: 'absolute', top: '20px', left: 0, right: 0, bottom: 0 }}>
          {project.tracks.length > 0 ? (
            project.tracks.map((track, trackIndex) => (
              <div
                key={track.id}
                style={{
                  position: 'absolute',
                  top: `${trackIndex * 30}px`,
                  left: 0,
                  right: 0,
                  height: '28px',
                  backgroundColor: '#333',
                  marginBottom: '2px'
                }}
              >
                {track.elements.map(elementId => {
                  const element = project.elements[elementId];
                  if (!element) return null;

                  return (
                    <div
                      key={element.id}
                      style={{
                        position: 'absolute',
                        left: `${(element.start / duration) * 100}%`,
                        width: `${(element.duration / duration) * 100}%`,
                        height: '100%',
                        backgroundColor: element.type === 'text' ? '#3498db' : 
                                        element.type === 'video' ? '#e74c3c' : 
                                        element.type === 'image' ? '#f39c12' : '#9b59b6',
                        borderRadius: '4px',
                        padding: '4px 8px',
                        fontSize: '12px',
                        color: '#fff',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {element.type === 'text' ? element.content : element.assetId?.split('/').pop()}
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
                  top: `${idx * 30}px`,
                  left: 0,
                  right: 0,
                  height: '28px',
                  backgroundColor: '#333',
                  marginBottom: '2px'
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: `${(element.start / duration) * 100}%`,
                    width: `${(element.duration / duration) * 100}%`,
                    height: '100%',
                    backgroundColor: element.type === 'text' ? '#3498db' : 
                                    element.type === 'video' ? '#e74c3c' : 
                                    element.type === 'image' ? '#f39c12' : '#9b59b6',
                    borderRadius: '4px',
                    padding: '4px 8px',
                    fontSize: '12px',
                    color: '#fff',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {element.type === 'text' ? element.content : element.assetId?.split('/').pop()}
                </div>
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
  );
};
