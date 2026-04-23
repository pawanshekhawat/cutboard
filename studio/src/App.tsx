import { useState, useEffect, useCallback, useRef } from 'react';
import { Canvas } from './components/Canvas';
import { Timeline } from './components/Timeline';
import { TheatrePanel } from './components/TheatrePanel';
import { api, type ProjectData } from './lib/api';
import { 
  initializeStudioPanel, 
  initializeTheatreSync, 
  syncTheatreFromExternal,
  lockElement,
  unlockElement
} from './lib/theatre-sync';
import './App.css';

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';

function App() {
  const [project, setProject] = useState<ProjectData | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [externalUpdate, setExternalUpdate] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const theatreInitializedRef = useRef(false);
  const pendingUpdatesRef = useRef<Array<{ elementId: string; path: string[]; value: any }>>([]);

  // Initialize Theatre.js studio on mount
  useEffect(() => {
    initializeStudioPanel();
  }, []);

  // Sync Theatre.js when project updates externally
  useEffect(() => {
    if (externalUpdate && project) {
      syncTheatreFromExternal(project);
      setExternalUpdate(false);
    }
  }, [externalUpdate, project]);

  // Handle Theatre.js updates -> Backend API
  const handleTheatreUpdate = useCallback(async (updates: Array<{ elementId: string; path: string[]; value: any }>) => {
    console.log('Theatre.js update:', updates);
    
    for (const update of updates) {
      const { elementId, path, value } = update;
      
      // Lock the element to prevent sync loop
      lockElement(elementId, path.join('.'));
      
      try {
        // Send update to backend
        await api.updateElement(PROJECT_PATH, elementId, {
          [path[0]]: path.length === 2 ? { [path[1]]: value } : value
        });
      } catch (error) {
        console.error('Failed to update element:', error);
      } finally {
        // Unlock after a short delay to allow for continuous editing
        setTimeout(() => {
          unlockElement(elementId, path.join('.'));
        }, 100);
      }
    }
  }, []);
  // Load project on mount
  const loadProject = useCallback(async () => {
    try {
      const data = await api.getProject(PROJECT_PATH);
      setProject(data);
      setIsConnected(true);
      
      // Initialize Theatre.js sync after first load
      if (!theatreInitializedRef.current && data) {
        initializeTheatreSync(data, 
          (elementId, path, value) => {
            handleTheatreUpdate([{ elementId, path, value }]);
          },
          handleTheatreUpdate
        );
        theatreInitializedRef.current = true;
      }
    } catch (error) {
      console.error('Failed to load project:', error);
      setIsConnected(false);
    }
  }, [handleTheatreUpdate]);

  // Initial load
  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // SSE connection for real-time updates
  useEffect(() => {
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
        setExternalUpdate(true);
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

      {/* Theatre.js Panel */}
      {project && (
        <div style={{
          position: 'fixed',
          right: 0,
          top: '60px',
          bottom: '140px',
          zIndex: 100
        }}>
          <TheatrePanel project={project} onUpdate={loadProject} />
        </div>
      )}
    </div>
  );
}

export default App;
