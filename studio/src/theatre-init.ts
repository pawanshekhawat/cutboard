// theatre-init.ts
// Initialize Theatre.js Studio as early as possible in the application lifecycle.
// This module MUST be imported before any other module that uses Theatre.js.

import studio from '@theatre/studio';

// Initialize immediately when this module is evaluated.
// Vite processes imports synchronously, so by the time other modules
// are loaded, the studio is already initialized.
// Try both common export shapes:
// - ESM default export is the studio object
// - Sometimes bundlers expose it under { default: studio }
const studioAny = studio as any;
const studioImpl =
  typeof studioAny?.initialize === 'function'
    ? studioAny
    : typeof studioAny?.default?.initialize === 'function'
      ? studioAny.default
      : null;

studioImpl?.initialize?.();