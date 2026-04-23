import React, { useEffect, useState } from 'react';
import { api, type ProjectData } from '../lib/api';

interface TheatrePanelProps {
  project: ProjectData | null;
  onUpdate?: () => void;
}

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';

export const TheatrePanel: React.FC<TheatrePanelProps> = ({ project, onUpdate }) => {
  const [selectedElement, setSelectedElement] = useState<string | null>(null);

  const handleTransformChange = async (elementId: string, property: string, value: number) => {
    if (!project) return;

    try {
      await api.updateElement(PROJECT_PATH, elementId, {
        transform: {
          ...project.elements[elementId].transform,
          [property]: value
        }
      });
      onUpdate?.();
    } catch (error) {
      console.error(`Failed to update ${property}:`, error);
    }
  };

  useEffect(() => {
    if (!project) return;

    // Auto-select first element if none selected
    const elementIds = Object.keys(project.elements);
    if (elementIds.length > 0 && !selectedElement) {
      setSelectedElement(elementIds[0]);
    }
  }, [project, selectedElement]);

  if (!project) return null;

  const elements = Object.values(project.elements);
  const animations = project.animations ? Object.values(project.animations) : [];

  return (
    <div style={{
      width: '300px',
      backgroundColor: '#1a1a1a',
      color: '#fff',
      padding: '15px',
      overflowY: 'auto',
      borderLeft: '1px solid #333'
    }}>
      <h3 style={{ margin: '0 0 15px 0', fontSize: '16px' }}>🎭 Theatre.js Panel</h3>

      {/* Element List */}
      <div style={{ marginBottom: '20px' }}>
        <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#888' }}>Elements</h4>
        {elements.map(el => (
          <button
            key={el.id}
            onClick={() => setSelectedElement(el.id)}
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 12px',
              marginBottom: '4px',
              backgroundColor: selectedElement === el.id ? '#3498db' : '#2a2a2a',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: '13px'
            }}
          >
            {el.type === 'text' ? '📝 ' : el.type === 'video' ? '🎬 ' : '🖼️ '}
            {el.type === 'text' ? el.content : el.assetId?.split('/').pop()}
          </button>
        ))}
      </div>

      {/* Selected Element Properties */}
      {selectedElement && (
        <div style={{ marginBottom: '20px' }}>
          <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#888' }}>
            Transform Properties
          </h4>
          
          {(() => {
            const el = project.elements[selectedElement];
            if (!el) return null;

            return (
              <div style={{ fontSize: '12px' }}>
                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', color: '#888', marginBottom: '4px' }}>
                    Position X: {el.transform.x.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max={project.meta.resolution.width}
                    value={el.transform.x}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value);
                      handleTransformChange(selectedElement, 'x', newValue);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', color: '#888', marginBottom: '4px' }}>
                    Position Y: {el.transform.y.toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max={project.meta.resolution.height}
                    value={el.transform.y}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value);
                      handleTransformChange(selectedElement, 'y', newValue);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', color: '#888', marginBottom: '4px' }}>
                    Scale: {el.transform.scale.toFixed(2)}
                  </label>
                  <input
                    type="range"
                    min="0.1"
                    max="3"
                    step="0.1"
                    value={el.transform.scale}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value);
                      handleTransformChange(selectedElement, 'scale', newValue);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', color: '#888', marginBottom: '4px' }}>
                    Rotation: {el.transform.rotation.toFixed(1)}°
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={el.transform.rotation}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value);
                      handleTransformChange(selectedElement, 'rotation', newValue);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '8px' }}>
                  <label style={{ display: 'block', color: '#888', marginBottom: '4px' }}>
                    Opacity: {(el.transform.opacity * 100).toFixed(0)}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={el.transform.opacity}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value);
                      handleTransformChange(selectedElement, 'opacity', newValue);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Animations Summary */}
      <div>
        <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#888' }}>
          Animations ({animations.length})
        </h4>
        {animations.length === 0 ? (
          <p style={{ fontSize: '12px', color: '#666' }}>No animations defined</p>
        ) : (
          <div style={{ fontSize: '12px' }}>
            {animations.map(anim => (
              <div
                key={anim.id}
                style={{
                  padding: '6px 8px',
                  backgroundColor: '#2a2a2a',
                  borderRadius: '4px',
                  marginBottom: '4px'
                }}
              >
                <div style={{ color: '#3498db', fontWeight: 'bold' }}>
                  {anim.target.split('_').slice(1).join('_')}
                </div>
                <div style={{ color: '#888', fontSize: '11px' }}>
                  {anim.property} • {anim.keyframes.length} keyframes
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
