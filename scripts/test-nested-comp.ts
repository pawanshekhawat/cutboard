// Nested composition sanity script
//
// Run from repo root:
//   cutboard exec scripts/test-nested-comp.ts
//
// This script registers a composition asset and places it on the timeline.
// It writes into the *current* project.json in the repo root.

const compAssetId = api.registerAsset({
  type: 'composition',
  src: 'test-project/nested-child',
});

api.addComposition({
  id: 'el_comp_nested_child',
  assetId: compAssetId,
  start: 1,
  duration: 4,
  trimStart: 0,
});

api.addText({
  content: 'parent overlay',
  start: 0,
  duration: 6,
  style: { fontSize: 64, color: '#ffffff' },
});

