# CutBoard Studio 🎬

Visual editing interface for CutBoard projects. Built with Vite + React + TypeScript.

## Architecture

**Golden Rule:** No UI-only state. The UI is purely a visual reflection of `project.json`.

### Components

- **Canvas** - Renders project elements with CSS transforms based on current time
- **Timeline** - Playback controls and track visualization
- **File Watcher** - Chokidar watches `project.json` for external changes

### API Server

The backend (`src/server/index.ts`) provides:

- `GET /api/project` - Load project.json
- `POST /api/project/element` - Update element properties
- `POST /api/project/keyframe` - Update keyframe values
- `GET /assets/:path` - Serve asset files

## Running

### Start API Server (from cutboard root)
```bash
npm run server
```

### Start Studio Dev Server
```bash
npm run studio
```

Or from studio directory:
```bash
npm run dev
```

Studio runs at: http://localhost:5173
API runs at: http://localhost:3001

## File Structure

```
studio/
├── src/
│   ├── components/
│   │   ├── Canvas.tsx      # Preview canvas
│   │   └── Timeline.tsx    # Timeline UI
│   ├── lib/
│   │   └── api.ts          # API client
│   ├── App.tsx             # Main app with watcher
│   └── App.css
└── package.json
```

## Next Steps (Phase 3)

- ✅ Scaffold Vite + React + TypeScript app
- ✅ Canvas preview with CSS transforms
- ✅ File watcher for project.json changes
- ✅ API server for reading/writing project data
- ⏳ Theatre.js integration for timeline/keyframe UI
- ⏳ Two-way sync: UI changes → project.json updates

## Theatre.js Integration (TODO)

Once Theatre.js is integrated:
1. Initialize Theatre state from `project.json` animations
2. Intercept Theatre.js changes and POST to API
3. Maintain single source of truth in project.json
