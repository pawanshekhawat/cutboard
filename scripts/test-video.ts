// Test script: real video + text overlay
// Run: npx tsx scripts/test-video.ts

import { loadProject, saveProject } from '../src/engine/project.js';
import { probeAsset } from '../src/engine/render.js';
import { randomId } from '../src/utils/id.js';

const ROOT = './test-project';

function main() {
  const project = loadProject(ROOT);

  // Clear old test elements from previous runs
  delete project.elements['el_text_a175e5'];
  delete project.elements['el_video_6ad216'];
  delete project.elements['el_video_444355'];

  // Add video asset (probed from real file)
  const assetId = 'vid_clip1';
  const src = './assets/clip.mp4';
  const probe = probeAsset('./test-project/assets/clip.mp4');
  console.log(`Probe: ${probe.duration}s, ${probe.width}x${probe.height}`);

  project.assets[assetId] = { type: 'video', src, duration: probe.duration };

  // Clip 1: global t=0–5, play from source t=2s, for 5s → shows source[2s–7s]
  const el1 = {
    id: `el_video_${randomId(6)}`,
    type: 'video' as const,
    assetId,
    start: 0, duration: 5,
    trimStart: 2, trimDuration: 5,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  };

  // Clip 2: global t=4–7, play from source t=5s, for 3s → shows source[5s–8s] (overlaps el1)
  const el2 = {
    id: `el_video_${randomId(6)}`,
    type: 'video' as const,
    assetId,
    start: 4, duration: 3,
    trimStart: 5, trimDuration: 3,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  };

  // Text overlay on clip 1
  const textEl = {
    id: 'el_txt_hello',
    type: 'text' as const,
    content: 'Hello CutBoard',
    style: { fontSize: 64, color: '#ffffff' },
    start: 1, duration: 4,
    transform: { x: 80, y: 500, scale: 1, rotation: 0, opacity: 1 },
  };

  project.elements[el1.id] = el1;
  project.elements[el2.id] = el2;
  project.elements[textEl.id] = textEl;

  project.tracks = [
    { id: 'track_video_main', type: 'video' as const, elements: [el1.id, el2.id] },
    { id: 'track_text_top', type: 'text' as const, elements: [textEl.id] },
  ];

  project.meta.duration = Math.max(
    ...Object.values(project.elements).map(el => el.start + el.duration)
  );

  saveProject(project, ROOT);
  console.log(`✓ Project saved — ${Object.keys(project.elements).length} elements, ${project.meta.duration}s duration`);
}

main();