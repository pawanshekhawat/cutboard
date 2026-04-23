import studio from '@theatre/studio';

// Theatre Studio must be initialized synchronously at the entry point.
// Note: bundlers may expose it under { default: studio }.
const studioAny = studio as any;
const studioImpl =
  typeof studioAny?.initialize === 'function'
    ? studioAny
    : typeof studioAny?.default?.initialize === 'function'
      ? studioAny.default
      : null;

studioImpl?.initialize?.();

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
