# CutBoard 🎬

**Agent-First Programmable Video Engine**

CutBoard is a Node.js-based video rendering engine that uses FFmpeg for frame-accurate video processing. It features a React Studio UI with Theatre.js for timeline editing, while maintaining `project.json` as the single source of truth.

## Overview

CutBoard solves the **video rendering problem** for AI agents by:
- Providing a **scriptable API** for video composition (add videos, text, images, audio)
- Using **FFmpeg** for actual video rendering (frame-accurate trimming, overlay, concatenation)
- Offering a **visual Studio UI** with Theatre.js for human editors
- Maintaining **"No UI-only state"** — the UI is purely a visual reflection of `project.json`

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│   Studio UI     │ ←HTTP→  │   API Server     │
│ (localhost:5173)│         │ (localhost:3001) │
└────────┬────────┘         └────────┬─────────┘
         │                           │
         │         Read/Write        │
         └──────────→ project.json ←─┘
                      ↓
              SSE Stream (Real-time)
              (Chokidar on backend)
```

### Core Principles

1. **Single Source of Truth** — `project.json` is the canonical state
2. **No UI-Only State** — UI never holds state that isn't in `project.json`
3. **Agent-First** — All mutations go through the backend API
4. **Real-Time Sync** — SSE stream keeps all clients in sync

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Fastify, Node.js, TypeScript |
| Video Processing | FFmpeg (via ffmpeg-static) |
| CLI | Commander.js |
| Studio UI | Vite + React + TypeScript |
| Animation UI | Theatre.js |
| File Watching | Chokidar |
| Real-Time | Server-Sent Events (SSE) |

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/pawanshekhawat/cutboard.git
cd cutboard

# Install dependencies
npm install

# Install FFmpeg (bundled)
npm run postinstall
```

### Running the Studio

```bash
# Terminal 1 - Start API Server
npm run server

# Terminal 2 - Start Studio UI
npm run studio

# Open browser
open http://localhost:5173
```

### CLI Commands

```bash
# Create new project
cutboard init my-project

# Render project to video
cutboard render

# Run script
cutboard exec script.ts
```

## Project Structure

```
cutboard/
├── src/
│   ├── cli/           # Commander CLI commands
│   ├── engine/        # Core rendering engine
│   │   ├── render.ts  # FFmpeg rendering pipeline
│   │   └── project.ts # Project file operations
│   ├── script-engine/ # Script execution API
│   ├── server/        # Fastify API + SSE
│   ├── types/         # Schema definitions
│   └── utils/         # Utilities (ID generation)
├── studio/            # React Studio UI
│   ├── src/
│   │   ├── components/
│   │   │   ├── Canvas.tsx    # Preview canvas
│   │   │   ├── Timeline.tsx  # Timeline controls
│   │   │   └── TheatrePanel.tsx
│   │   ├── lib/
│   │   │   ├── api.ts        # API client
│   │   │   └── theatre-sync.ts # Theatre.js sync
│   │   └── App.tsx
│   └── package.json
├── assets/            # Video/image assets
├── scripts/           # Build scripts
└── project.json       # Current project state
```

## Project Schema (project.json)

```json
{
  "version": "1.0",
  "meta": {
    "name": "My Project",
    "fps": 30,
    "resolution": { "width": 1920, "height": 1080 },
    "duration": 10
  },
  "assets": {
    "assets/video.mp4": {
      "type": "video",
      "src": "assets/video.mp4",
      "duration": 5
    }
  },
  "elements": {
    "el_abc123": {
      "id": "el_abc123",
      "type": "video",
      "assetId": "assets/video.mp4",
      "start": 0,
      "duration": 5,
      "trimStart": 0,
      "trimDuration": 5,
      "transform": {
        "x": 0, "y": 0, "scale": 1, "rotation": 0, "opacity": 1
      }
    }
  },
  "tracks": [],
  "animations": {
    "anim_xyz": {
      "id": "anim_xyz",
      "target": "el_abc123",
      "property": "transform.x",
      "keyframes": [
        { "time": 0, "value": 0 },
        { "time": 3, "value": 500 }
      ],
      "easing": "easeInOut"
    }
  }
}
```

## FFmpeg Rendering

The rendering engine uses FFmpeg for frame-accurate video processing:

### Trimming Algebra

```
Source: video.mp4 [0s ──────────────────── 10s]
Target: t=0 ────────────────────────────── t=5s
Trim:   trimStart=2, trimDuration=4

Formula: -itsoffset {trimStart} -i input.mp4 -t {trimDuration}
         -map 0:v:0 -map 0:a:0

Result: Source 2s-6s → Output 0s-4s ✓
```

### Text Overlay (drawtext)

```
ffmpeg -i input.mp4 -vf "drawtext=text='Hello':fontsize=48:fontcolor=white:x=100:y=100" output.mp4
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/api/project` | Get project.json |
| GET | `/api/project/frame` | Proxy preview frame at time |
| GET | `/api/audio/waveform` | Extract normalized audio peaks (cached) |
| POST | `/api/assets` | Upload asset (video/audio/image) |
| POST | `/api/project/element` | Patch an existing element |
| POST | `/api/project/elements` | Create a new element on a track |
| DELETE | `/api/project/elements/:elementId` | Delete an element |
| PUT | `/api/project/tracks/reorder` | Reorder tracks (layering) |
| POST | `/api/project/keyframe` | Update keyframe |
| POST | `/api/project/animation` | Add animation |
| GET | `/api/stream` | SSE real-time updates |

## Script Engine API

```typescript
// Add video element
project.addVideo({
  id: 'clip1',
  src: 'assets/intro.mp4',
  start: 0,
  duration: 5
});

// Add text overlay
project.addText({
  id: 'title',
  content: 'Welcome!',
  start: 0,
  duration: 3,
  style: { fontSize: 48, color: '#00ff00' }
});

// Set keyframe animation
project.setKeyframe('title', 'transform.x', 0, 0);
project.setKeyframe('title', 'transform.x', 3, 500);

// Execute FFmpeg render
await project.render('output.mp4');
```

## Nested compositions (pre-comps)

CutBoard supports an asset type `composition` that points at another CutBoard project (a folder containing a `project.json`, or a direct path to a `project.json`). At render time and in Studio **Proxy** mode, referenced child compositions are pre-rendered into deterministic cache files under `output/.cache/compositions/` and then treated like regular video inputs in the parent timeline.

### Fixtures

- **Child**: `test-project/nested-child/project.json`
- **Parent**: `test-project/nested-parent/project.json` (references the child as a `composition` asset)

### Verify render + proxy parity

```bash
# Render the parent fixture (from repo root)
cutboard render --path "test-project/nested-parent/project.json" --output "output/nested-parent.mp4"

# Start server + studio, then enable Proxy mode in the Studio UI and scrub t=1..5s
# The first proxy frame request will (re)build the child cache under:
#   output/.cache/compositions/
```

## Theatre.js Integration

The Studio UI uses Theatre.js for professional timeline editing:

### Two-Way Sync

1. **Theatre.js → project.json**: When user drags a keyframe in Theatre.js:
   - Theatre.js emits value change
   - Frontend sends PUT to `/api/project/element`
   - Backend writes to `project.json`
   - SSE broadcasts update to all clients

2. **project.json → Theatre.js**: When `project.json` is updated externally:
   - Backend detects via Chokidar
   - SSE sends update event
   - Frontend re-fetches project and syncs Theatre.js
   - Editing locks prevent sync loops during active drag

### Lock Mechanism

```typescript
const editingLocks = new Map<string, Set<string>>();

// When user starts dragging
lockElement(elementId, 'transform.x');

// After drag completes
setTimeout(() => unlockElement(elementId, 'transform.x'), 100);
```

## Current Status

### ✅ Completed
- [x] FFmpeg rendering pipeline (frame-accurate trimming)
- [x] Script Engine API (addVideo, addText, addImage, setKeyframe)
- [x] Fastify API Server with SSE
- [x] React Studio UI (Canvas + Timeline + Asset Manager)
- [x] Asset uploads + draggable asset library
- [x] Timeline drag-and-drop (assets → timeline)
- [x] Track rows + track reordering (layering)
- [x] Clip editing: move (start) + NLE-style trims (trimStart + duration)
- [x] Audio playback in Studio (hidden `<audio>` synced to playhead)
- [x] Audio waveform rendering in timeline (cached + trim-respecting)
- [x] Right-click clip context menu with Delete
- [x] Theatre.js integration with two-way sync + write-back
- [x] Chokidar file watcher on backend
- [x] No UI-only state architecture

### 🔄 In Progress
- [ ] Rich track model (multi-clip lanes per track, overlap rules, snapping)
- [ ] Timeline operations (duplicate, split, ripple delete)
- [ ] Effects + blend modes surfaced in the context menu

### 📋 TODO
- [ ] Export to Remotion composition
- [ ] Collaborative editing via WebSocket

## Contributing

This project is part of the **Kailash Command** initiative — an AI-native video production workflow.

## License

MIT
