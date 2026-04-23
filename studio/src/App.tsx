import { useState, useEffect, useCallback, useRef } from 'react';
import { Canvas } from './components/Canvas';
import { Timeline } from './components/Timeline';
import { api, type ProjectData } from './lib/api';
import {
  applyExternalProjectToTheatre,
  enableTheatreWriteBack,
  initializeTheatreNative,
  setTheatreTime,
} from './lib/theatre-native';
import './App.css';

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';

function App() {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [, setIsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const didInitRef = useRef(false);
  const didSseRef = useRef(false);
  const theatreSeededRef = useRef(false);

  // Load project
  const loadProject = useCallback(async () => {
    try {
      const data = await api.getProject(PROJECT_PATH);
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
    eventSourceRef.current = new EventSource('http://localhost:3001/api/stream');

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
    <div className="app">
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
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '40px',
        backgroundColor: '#0f0f0f',
        minHeight: 'calc(100vh - 140px)'
      }}>
        <Canvas project={project} currentTime={currentTime} />
      </main>

      <footer style={{ position: 'fixed', bottom: 0, left: 0, right: 0 }}>
        <Timeline
          project={project}
          currentTime={currentTime}
          onTimeChange={handleTimeChange}
          onPlayPause={handlePlayPause}
          isPlaying={isPlaying}
        />
      </footer>

      {/* Native Theatre Studio UI now handles editing + keyframing */}
    </div>
  );
}

export default App;
