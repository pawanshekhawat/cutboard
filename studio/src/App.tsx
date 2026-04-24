import { useState, useEffect, useCallback, useRef } from 'react';
import { Canvas } from './components/Canvas';
import { Timeline } from './components/Timeline';
import { AssetManager } from './components/AssetManager';
import { api, type ProjectData } from './lib/api';
import { buildApiUrl } from './lib/config';
import {
  applyExternalProjectToTheatre,
  enableTheatreWriteBack,
  initializeTheatreNative,
  setTheatreTime,
} from './lib/theatre-native';
import './App.css';

function App() {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isProxyMode, setIsProxyMode] = useState(false);
  const [, setIsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const didInitRef = useRef(false);
  const didSseRef = useRef(false);
  const theatreSeededRef = useRef(false);

  // Load project
  const loadProject = useCallback(async () => {
    try {
      const data = await api.getProject();
      setProject(data);
      setIsConnected(true);
    } catch (error) {
      console.error('Failed to load project:', error);
      setIsConnected(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;
    loadProject();
  }, [loadProject]);

  // Initialize Theatre from project.json
  useEffect(() => {
    if (!project) return;
    if (theatreSeededRef.current) return;
    theatreSeededRef.current = true;
    (async () => {
      await initializeTheatreNative(project, {
        onSequencePosition: (t) => setCurrentTime(t),
      });
      enableTheatreWriteBack();
      // Ensure playhead starts at current time
      setTheatreTime(currentTime);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.version]);

  // SSE connection for real-time updates
  useEffect(() => {
    if (didSseRef.current) return;
    didSseRef.current = true;
    eventSourceRef.current = new EventSource(buildApiUrl('/api/stream'));

    eventSourceRef.current.onopen = () => {
      console.log('SSE connected');
      setSseConnected(true);
      setIsConnected(true);
    };

    eventSourceRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'update') {
        console.log('Project updated externally, reloading...');
        loadProject();
      }
    };

    eventSourceRef.current.onerror = (error) => {
      console.error('SSE error:', error);
      setSseConnected(false);
      setIsConnected(false);
    };

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [loadProject]);

  // After any project reload (SSE/manual), apply external transforms to Theatre.
  useEffect(() => {
    if (!project) return;
    applyExternalProjectToTheatre(project);
  }, [project]);

  // Playback loop
  useEffect(() => {
    if (!isPlaying || !project) return;

    const interval = setInterval(() => {
      setCurrentTime(prev => {
        const next = prev + (1000 / project.meta.fps) / 1000;
        if (next >= project.meta.duration) {
          setIsPlaying(false);
          return 0;
        }
        setTheatreTime(next);
        return next;
      });
    }, 1000 / project.meta.fps);

    return () => clearInterval(interval);
  }, [isPlaying, project]);

  const handlePlayPause = () => {
    setIsPlaying(!isPlaying);
  };

  const handleTimeChange = (time: number) => {
    setCurrentTime(time);
    setIsPlaying(false);
    setTheatreTime(time);
  };

  return (
    <div className="app" style={{ height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '20px',
        backgroundColor: '#1a1a1a',
        color: '#fff',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <h1 style={{ margin: 0, fontSize: '24px' }}>🎬 CutBoard Studio</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: '#ddd',
            backgroundColor: '#2a2a2a',
            padding: '6px 10px',
            borderRadius: '6px'
          }}>
            <input
              type="checkbox"
              checked={isProxyMode}
              onChange={(e) => setIsProxyMode(e.target.checked)}
            />
            Proxy Mode
          </label>
          <span style={{
            fontSize: '14px',
            color: sseConnected ? '#2ecc71' : '#e74c3c'
          }}>
            {sseConnected ? '● SSE Connected' : '● Disconnected'}
          </span>
          <button
            onClick={loadProject}
            style={{
              padding: '8px 16px',
              backgroundColor: '#3498db',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer'
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      <main style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 300px',
        columnGap: '0',
        padding: '20px 0 20px 40px',
        backgroundColor: '#0f0f0f',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}>
        <div style={{ minWidth: 0, paddingRight: '24px', overflow: 'auto' }}>
          <Canvas
            project={project}
            currentTime={currentTime}
            isProxyMode={isProxyMode}
            isPlaying={isPlaying}
          />
        </div>
        <AssetManager project={project} currentTime={currentTime} onProjectRefresh={loadProject} />
      </main>

      <footer style={{ flexShrink: 0 }}>
        <Timeline
          project={project}
          currentTime={currentTime}
          onTimeChange={handleTimeChange}
          onPlayPause={handlePlayPause}
          isPlaying={isPlaying}
          onProjectRefresh={loadProject}
        />
      </footer>

      {/* Native Theatre Studio UI now handles editing + keyframing */}
    </div>
  );
}

export default App;
