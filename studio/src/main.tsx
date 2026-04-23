import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { studio } from '@theatre/studio'
import './index.css'
import App from './App.tsx'

// Initialize Theatre.js studio immediately on module load
studio.initialize()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
