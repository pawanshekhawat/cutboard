import Theatre, { getProject } from '@theatre/studio';
import type { ProjectData } from './api';

// Theatre.js v0.7+ auto-initializes on import
const THEATRE_PROJECT = getProject('CutBoard');

// Track which elements are being edited to prevent sync loops
const editingLocks = new Map<string, Set<string>>();

export interface TheatreElement {
  transform: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    opacity: number;
  };
}

/**
 * Initialize Theatre.js studio and sync with project.json
 */
export function initializeTheatreSync(
  project: ProjectData,
  onUpdate: (elementId: string, path: string[], value: any) => void,
  onBulkUpdate: (updates: Array<{ elementId: string; path: string[]; value: any }>) => void
) {
  // Clear existing sheets
  THEATRE_PROJECT.sheets = {};

  // Create a sheet for each element
  Object.entries(project.elements).forEach(([elementId, element]) => {
    const sheet = THEATRE_PROJECT.sheet(elementId, 'Element');
    
    // Create Theatre.js object for this element
    const obj = sheet.object(elementId, {
      transform: {
        x: element.transform.x,
        y: element.transform.y,
        scale: element.transform.scale,
        rotation: element.transform.rotation,
        opacity: element.transform.opacity,
      }
    });

    // Subscribe to changes
    obj.onValuesChange((values) => {
      // Check if we're currently editing this element (prevent loop)
      if (isElementLocked(elementId)) {
        return;
      }

      const updates: Array<{ elementId: string; path: string[]; value: any }> = [];

      if (values.transform) {
        const transform = values.transform as TheatreElement['transform'];
        
        if (transform.x !== undefined) {
          updates.push({ elementId, path: ['transform', 'x'], value: transform.x });
        }
        if (transform.y !== undefined) {
          updates.push({ elementId, path: ['transform', 'y'], value: transform.y });
        }
        if (transform.scale !== undefined) {
          updates.push({ elementId, path: ['transform', 'scale'], value: transform.scale });
        }
        if (transform.rotation !== undefined) {
          updates.push({ elementId, path: ['transform', 'rotation'], value: transform.rotation });
        }
        if (transform.opacity !== undefined) {
          updates.push({ elementId, path: ['transform', 'opacity'], value: transform.opacity });
        }
      }

      if (updates.length > 0) {
        onBulkUpdate(updates);
      }
    });
  });

  return THEATRE_PROJECT;
}

/**
 * Update Theatre.js object values from external changes (SSE)
 * Respects editing locks to prevent overwriting user edits
 */
export function syncTheatreFromExternal(project: ProjectData) {
  Object.entries(project.elements).forEach(([elementId, element]) => {
    // Skip if user is actively editing this element
    if (isElementLocked(elementId)) {
      return;
    }

    const sheet = THEATRE_PROJECT.sheet(elementId, 'Element');
    const obj = sheet.object(elementId);

    // Update transform values
    obj.replaceProps({
      transform: {
        x: element.transform.x,
        y: element.transform.y,
        scale: element.transform.scale,
        rotation: element.transform.rotation,
        opacity: element.transform.opacity,
      }
    });
  });
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
 * Get Theatre.js project for manual access
 */
export function getTheatreProject() {
  return THEATRE_PROJECT;
}

/**
 * Hide Theatre.js studio panel (call to hide the studio UI)
 */
export function hideStudioPanel() {
  Theatre.ui.hide();
}

/**
 * Show Theatre.js studio panel
 */
export function showStudioPanel() {
  Theatre.ui.restore();
}

/**
 * Check if studio panel is hidden
 */
export function isStudioPanelHidden(): boolean {
  return Theatre.ui.isHidden;
}
