import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Theatre from '@theatre/studio'
import './index.css'
import App from './App.tsx'

// Theatre.js v0.7+ auto-initializes on import
// The studio UI is controlled via Theatre.ui.hide()/restore()
// If you want to hide the studio panel by default, uncomment:
// Theatre.ui.hide()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
