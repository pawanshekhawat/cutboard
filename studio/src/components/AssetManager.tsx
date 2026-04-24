import React, { useMemo, useRef, useState } from 'react';
import { api, type ProjectData } from '../lib/api';
import { PROJECT_PATH } from '../lib/config';

interface AssetManagerProps {
  project: ProjectData | null;
  onProjectRefresh?: () => Promise<void> | void;
}

const iconByType: Record<string, string> = {
  video: '🎬',
  audio: '🔊',
  image: '🖼️',
  composition: '🧩',
};

function basename(src: string): string {
  const normalized = String(src || '').replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || src;
}

export const AssetManager: React.FC<AssetManagerProps> = ({ project, onProjectRefresh }) => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const assets = useMemo(() => {
    if (!project) return [];
    return Object.entries(project.assets || {}).map(([assetId, asset]) => ({ assetId, ...asset }));
  }, [project]);

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    try {
      await api.uploadAsset(PROJECT_PATH, file);
      await Promise.resolve(onProjectRefresh?.());
    } catch (error: any) {
      setUploadError(error?.response?.data?.error || error?.message || 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <aside
      style={{
        width: '300px',
        minWidth: '300px',
        backgroundColor: '#151515',
        color: '#fff',
        borderLeft: '1px solid #2a2a2a',
        padding: '14px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        height: '100%',
        minHeight: 0,
      }}
    >
      <div style={{ fontSize: '16px', fontWeight: 700 }}>Assets</div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const dropped = e.dataTransfer?.files?.[0];
          void handleUpload(dropped);
        }}
        style={{
          border: `1px dashed ${isDragOver ? '#4da3ff' : '#3a3a3a'}`,
          borderRadius: '8px',
          padding: '12px',
          background: isDragOver ? 'rgba(77,163,255,0.12)' : '#1e1e1e',
          fontSize: '12px',
        }}
      >
        <div style={{ marginBottom: '8px' }}>Drop media file here</div>
        <button
          type="button"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '8px 10px',
            border: 'none',
            borderRadius: '6px',
            background: isUploading ? '#555' : '#3498db',
            color: '#fff',
            cursor: isUploading ? 'default' : 'pointer',
            fontSize: '12px',
          }}
        >
          {isUploading ? 'Uploading...' : 'Upload File'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const selected = e.target.files?.[0];
            void handleUpload(selected);
            e.currentTarget.value = '';
          }}
        />
      </div>

      {uploadError && (
        <div style={{ color: '#ff9a9a', fontSize: '12px' }}>{uploadError}</div>
      )}

      <div style={{ fontSize: '12px', color: '#9a9a9a' }}>
        Library ({assets.length})
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          paddingRight: '2px',
        }}
      >
        {assets.map((asset) => (
          <div
            key={asset.assetId}
            draggable
            onDragStart={(e) => {
              const payload = JSON.stringify({
                assetId: asset.assetId,
                type: asset.type,
                src: asset.src,
              });
              e.dataTransfer.setData('application/x-cutboard-asset', payload);
              e.dataTransfer.setData('text/plain', asset.assetId);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            style={{
              background: '#232323',
              border: '1px solid #353535',
              borderRadius: '8px',
              padding: '8px',
              cursor: 'grab',
              userSelect: 'none',
            }}
            title="Drag to timeline"
          >
            <div style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>{iconByType[asset.type] || '📦'}</span>
              <span>{basename(asset.src)}</span>
            </div>
            <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>{asset.type}</div>
          </div>
        ))}
        {assets.length === 0 && (
          <div style={{ color: '#777', fontSize: '12px' }}>
            No assets yet. Upload media to start building clips.
          </div>
        )}
      </div>
    </aside>
  );
};
