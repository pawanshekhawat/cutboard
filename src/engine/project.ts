import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { SCHEMA_VERSION, type Project } from '../types/schema.js';
import { normalizeProjectContract } from '../shared/project-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_FILE = 'project.json';

// ─── Validation ────────────────────────────────────────────────────────────
function validateProject(raw: unknown): Project {
  return normalizeProjectContract(raw).project;
}

function loadAndNormalizeProject(path: string): Project {
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const normalized = normalizeProjectContract(raw);
  if (normalized.changed) {
    writeFileSync(path, JSON.stringify(normalized.project, null, 2), 'utf-8');
  }
  return validateProject(normalized.project);
}

// ─── Load / Save ───────────────────────────────────────────────────────────
export function loadProject(root = '.'): Project {
  const path = resolve(root, PROJECT_FILE);
  if (!existsSync(path)) {
    throw new Error(`No project.json found at ${path}. Run "cutboard init" first.`);
  }
  return loadAndNormalizeProject(path);
}

export function loadProjectFromPath(projectJsonPath: string): Project {
  const path = resolve(projectJsonPath);
  if (!existsSync(path)) throw new Error(`No project.json found at ${path}`);
  return loadAndNormalizeProject(path);
}

export function resolveProjectRootFromSrc(parentRoot: string, src: string): string {
  const abs = resolve(parentRoot, src);
  if (abs.toLowerCase().endsWith(`${PROJECT_FILE}`)) return dirname(abs);
  if (!existsSync(abs)) return abs;

  const st = statSync(abs);
  if (st.isDirectory()) return abs;
  if (st.isFile() && basename(abs).toLowerCase() === PROJECT_FILE) return dirname(abs);
  return abs;
}

export function saveProject(project: Project, root = '.'): void {
  const path = resolve(root, PROJECT_FILE);
  writeFileSync(path, JSON.stringify(project, null, 2), 'utf-8');
}

// ─── Init ────────────────────────────────────────────────────────────────────
export function initProject(name = 'Untitled', root = '.'): Project {
  const path = resolve(root, PROJECT_FILE);
  if (existsSync(path)) {
    throw new Error('project.json already exists. Delete it first to re-init.');
  }

  const project: Project = {
    version: SCHEMA_VERSION,
    meta: {
      name,
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      duration: 0,
    },
    assets: {},
    tracks: [],
    elements: {},
    animations: {},
    effects: {},
  };

  saveProject(project, root);
  console.log(`✓ Initialised project "${name}" at ${path}`);
  return project;
}

// ─── Computed helpers ───────────────────────────────────────────────────────
// Derive total duration from all elements
export function computeDuration(elements: Project['elements']): number {
  let max = 0;
  for (const el of Object.values(elements)) {
    const end = el.start + el.duration;
    if (end > max) max = end;
  }
  return max;
}

// ─── Element CRUD helpers ──────────────────────────────────────────────────
import { randomId } from '../utils/id.js';

function addElement<T extends Project['elements'][string]>(
  project: Project,
  element: T
): Project {
  const { elements, tracks } = project;

  elements[element.id] = element;

  // Auto-create a track for this element if none exists for its type
  const typeTrack = tracks.find(t => t.type === (element.type as any));
  if (typeTrack) {
    typeTrack.elements.push(element.id);
  } else {
    tracks.push({
      id: `track_${element.type}_${randomId(4)}`,
      type: element.type as any,
      elements: [element.id],
    });
  }

  project.meta.duration = computeDuration(elements);
  return project;
}

function removeElement(project: Project, elementId: string): Project {
  const { elements, tracks, animations, effects } = project;

  delete elements[elementId];

  for (const track of tracks) {
    track.elements = track.elements.filter(id => id !== elementId);
  }

  // Remove orphaned animations/effects targeting this element
  for (const [key, anim] of Object.entries(animations)) {
    if (anim.target === elementId) delete animations[key];
  }
  for (const [key, fx] of Object.entries(effects)) {
    if (fx.target === elementId) delete effects[key];
  }

  project.meta.duration = computeDuration(elements);
  return project;
}
