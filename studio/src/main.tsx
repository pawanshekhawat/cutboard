import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@theatre/core'; // Must be imported first to register core with studio
import Theatre from '@theatre/studio'; // Studio auto-initializes after core is registered
import './index.css'
import App from './App.tsx'

// Theatre.js v0.6+ requires core to be imported first
// Studio auto-initializes when imported after core
// Use Theatre.ui.hide() if you want to hide the studio panel

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
