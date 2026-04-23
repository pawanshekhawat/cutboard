// Adds a background music track to the current project via script-engine API.
// Run from repo root:
//   npm run script -- scripts/add-bgm.ts
//
// Make sure the file exists at: assets/bgm.mp3

const bgmAssetId = api.registerAsset({
  type: 'audio',
  src: 'assets/bgm.mp3',
});

api.addAudio({
  id: 'el_audio_bgm',
  assetId: bgmAssetId,
  start: 0,
  duration: 12,
  trimStart: 0,
  volume: 0.35,
});

