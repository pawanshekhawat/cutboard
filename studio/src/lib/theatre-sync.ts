/**
 * CutBoard Theatre.js Sync Module
 * 
 * NOTE: Theatre.js v0.7+ has a different API structure and auto-initializes on import.
 * The studio UI shows automatically. For now, we use direct API calls in TheatrePanel
 * for the two-way sync, which bypasses Theatre.js internals.
 * 
 * This allows the user to test transform sliders immediately.
 */

import type { ProjectData } from './api';

// Lock mechanism to prevent sync loops during editing
const editingLocks = new Map<string, Set<string>>();

/**
 * Initialize Theatre.js sync with project.json
 * Currently simplified - TheatrePanel uses direct API calls
 */
export function initializeTheatreSync(
  project: ProjectData,
  onUpdate: (elementId: string, path: string[], value: any) => void,
  onBulkUpdate: (updates: Array<{ elementId: string; path: string[]; value: any }>) => void
) {
  console.log('Theatre.js sync initialized (API mode)');
  // In this simplified mode, TheatrePanel handles updates via direct API calls
  // Theatre.js integration will be enhanced in future iterations
}

/**
 * Update Theatre.js from external project changes
 */
export function syncTheatreFromExternal(project: ProjectData) {
  // External sync handled via SSE in App.tsx
  console.log('External sync triggered (handled via SSE)');
}

/**
 * Lock an element to prevent sync loops during editing
 */
export function lockElement(elementId: string, property?: string) {
  if (!editingLocks.has(elementId)) {
    editingLocks.set(elementId, new Set());
  }
  if (property) {
    editingLocks.get(elementId)!.add(property);
  }
}

/**
 * Unlock an element after editing is complete
 */
export function unlockElement(elementId: string, property?: string) {
  if (property) {
    editingLocks.get(elementId)?.delete(property);
  } else {
    editingLocks.delete(elementId);
  }
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

/**
 * Stub for Theatre.js project (not used in current simplified mode)
 */
export function getTheatreProject() {
  return null;
}

/**
 * Hide Theatre.js studio panel (if visible)
 */
export function hideStudioPanel() {
  // Theatre.js v0.7 shows automatically on import
  // This is a placeholder for future implementation
  console.log('Studio panel visibility control not yet implemented');
}

/**
 * Show Theatre.js studio panel
 */
export function showStudioPanel() {
  console.log('Studio panel visibility control not yet implemented');
}

/**
 * Check if studio panel is hidden
 */
export function isStudioPanelHidden(): boolean {
  return false;
}
