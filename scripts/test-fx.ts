// Effects sanity script
// Injects blur + grayscale on the first video element in project.json.
//
// Run:
//   npx tsx scripts/test-fx.ts

import { loadProject, saveProject } from '../src/engine/project.js';

function main() {
  const project = loadProject('.');

  const videoElement = Object.values(project.elements).find((el) => el.type === 'video');
  if (!videoElement) {
    throw new Error('No video element found in project.json to attach effects.');
  }

  const targetId = videoElement.id;

  project.effects['fx_blur_sanity'] = {
    id: 'fx_blur_sanity',
    target: targetId,
    type: 'blur',
    value: 10,
  };

  project.effects['fx_gray_sanity'] = {
    id: 'fx_gray_sanity',
    target: targetId,
    type: 'grayscale',
    value: 1,
  };

  saveProject(project, '.');
  console.log(`✓ Applied blur+grayscale sanity effects to video element: ${targetId}`);
}

main();

