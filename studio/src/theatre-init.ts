// theatre-init.ts
// Initialize Theatre.js Studio as early as possible.
// Must be the first import in main.tsx, before any other module that might use Theatre.

import studio from '@theatre/studio'

// Initialize immediately on module load, before any other imports can execute
// This prevents the "haven't initialized" warning that occurs when modules
// are evaluated out of order during development (HMR)
studio.initialize()
