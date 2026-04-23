/**
 * Theatre.js Sync Module
 * 
 * Theatre.js requires specific initialization order:
 * 1. Import @theatre/core first (registers the core)
 * 2. Import @theatre/studio (auto-initializes on import)
 * 3. getProject() is available via @theatre/core
 * 
 * If Theatre.js causes issues, this module falls back to direct API mode.
 */

import '@theatre/core'; // Must be imported first to register core
import Theatre from '@theatre/studio';
import { getProject as coreGetProject } from '@theatre/core';
import type { ProjectData } from './api';

// Lock mechanism to prevent sync loops during editing
const editingLocks = new Map<string, Set<string>>();

// Track if Theatre.js is properly initialized
let theatreInitialized = false;

/**
 * Initialize Theatre.js sync with project.json
 */
export function initializeTheatreSync(
  project: ProjectData,
  onUpdate: (elementId: string, path: string[], value: any) => void,
  onBulkUpdate: (updates: Array<{ elementId: string; path: string[]; value: any }>) => void
) {
  try {
    // Initialize studio if available
    if (typeof Theatre.initialize === 'function') {
      Theatre.initialize().catch(() => {
        // Already initialized or not in browser
      });
    }
    
    // Create sheets for each element
    Object.entries(project.elements).forEach(([elementId, element]) => {
      const sheet = coreGetProject('CutBoard').sheet(elementId, 'Element');
      const obj = sheet.object(elementId, {
        transform: {
          x: element.transform.x,
          y: element.transform.y,
          scale: element.transform.scale,
          rotation: element.transform.rotation,
          opacity: element.transform.opacity,
        }
      });

      obj.onValuesChange((values) => {
        if (isElementLocked(elementId)) return;
        
        const updates: Array<{ elementId: string; path: string[]; value: any }> = [];
        if (values.transform) {
          const t = values.transform as any;
          if (t.x !== undefined) updates.push({ elementId, path: ['transform', 'x'], value: t.x });
          if (t.y !== undefined) updates.push({ elementId, path: ['transform', 'y'], value: t.y });
          if (t.scale !== undefined) updates.push({ elementId, path: ['transform', 'scale'], value: t.scale });
          if (t.rotation !== undefined) updates.push({ elementId, path: ['transform', 'rotation'], value: t.rotation });
          if (t.opacity !== undefined) updates.push({ elementId, path: ['transform', 'opacity'], value: t.opacity });
        }
        if (updates.length > 0) onBulkUpdate(updates);
      });
    });
    
    theatreInitialized = true;
    console.log('Theatre.js sync initialized successfully');
  } catch (e) {
    console.warn('Theatre.js initialization failed, using API mode:', e);
    theatreInitialized = false;
  }
}

/**
 * Sync Theatre.js from external project changes
 */
export function syncTheatreFromExternal(project: ProjectData) {
  if (!theatreInitialized) return;
  // Sync logic would go here if Theatre.js is initialized
}

/**
 * Lock an element during editing to prevent sync loops
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
 * Check if an element is locked
 */
export function isElementLocked(elementId: string, property?: string): boolean {
  const locks = editingLocks.get(elementId);
  if (!locks) return false;
  if (property) return locks.has(property);
  return locks.size > 0;
}

/**
 * Get Theatre.js project
 */
export function getTheatreProject() {
  return coreGetProject('CutBoard');
}

/**
 * Hide studio panel
 */
export function hideStudioPanel() {
  Theatre.ui?.hide();
}

/**
 * Show studio panel
 */
export function showStudioPanel() {
  Theatre.ui?.restore();
}

/**
 * Check if studio panel is hidden
 */
export function isStudioPanelHidden(): boolean {
  return Theatre.ui?.isHidden ?? false;
}
