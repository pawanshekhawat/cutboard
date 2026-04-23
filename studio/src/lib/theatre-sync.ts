/**
 * CutBoard Theatre Sync Module
 * 
 * Currently using DIRECT API MODE (no Theatre.js dependency).
 * 
 * This module provides:
 * - Lock mechanism for sync loop prevention
 * - API-based transform updates (works reliably)
 * 
 * Theatre.js integration will be revisited when the API is more stable.
 */


// Lock mechanism to prevent sync loops during editing
const editingLocks = new Map<string, Set<string>>();

/**
 * Initialize sync (no-op in API mode - TheatrePanel handles updates directly)
 */
export function initializeTheatreSync() {
  console.log('CutBoard sync initialized (API mode)');
}

/**
 * Stub for external sync (would be used for SSE updates)
 */
export function syncTheatreFromExternal() {
  // SSE handles this via loadProject() in App.tsx
}

/**
 * Lock an element to prevent sync loops during editing
 */
export function lockElement(elementId: string, property?: string) {
  if (!editingLocks.has(elementId)) editingLocks.set(elementId, new Set());
  if (property) editingLocks.get(elementId)!.add(property);
}

/**
 * Unlock an element after editing
 */
export function unlockElement(elementId: string, property?: string) {
  if (property) editingLocks.get(elementId)?.delete(property);
  else editingLocks.delete(elementId);
}

/**
 * Check if an element is currently being edited
 */
export function isElementLocked(elementId: string, property?: string): boolean {
  const locks = editingLocks.get(elementId);
  if (!locks) return false;
  if (property) return locks.has(property);
  return locks.size > 0;
}
