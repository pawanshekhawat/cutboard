// Initialize Theatre Studio only in development to avoid bundling it in production
if (import.meta.env.DEV) {
  import('./theatre-init');
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
