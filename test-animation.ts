// Test Script: Text Animation (Linear Interpolation)
// Tests the animation system: text slides from left to right

const SAMPLE_VIDEO = 'assets/sample-10s.mp4';

// Register the video asset
api.registerAsset({
  type: 'video',
  src: SAMPLE_VIDEO,
});

// Add a video clip (full 5 seconds, no trim)
const videoId = api.addVideo({
  assetId: SAMPLE_VIDEO,
  start: 0,
  duration: 5,
  trimStart: 0,
  trimDuration: 5,
});

// Add text that slides from x=0 to x=500 over 3 seconds
// Keyframes: t=0 → x=0, t=3 → x=500
const textId = api.addText({
  content: 'Animation Test: Sliding Text!',
  start: 0,
  duration: 5,
  style: {
    fontSize: 48,
    color: '#00ff00',
    fontFamily: 'Arial',
  },
});

// Set keyframes for the slide animation
// At t=0, x=0 (left edge)
api.setKeyframe({
  elementId: textId,
  property: 'transform.x',
  time: 0,
  value: 0,
});

// At t=3, x=500 (slides right)
api.setKeyframe({
  elementId: textId,
  property: 'transform.x',
  time: 3,
  value: 500,
});

// Also animate Y: starts at y=100, moves to y=300 at t=3
api.setKeyframe({
  elementId: textId,
  property: 'transform.y',
  time: 0,
  value: 100,
});

api.setKeyframe({
  elementId: textId,
  property: 'transform.y',
  time: 3,
  value: 300,
});

console.log(`✓ Added video element: ${videoId}`);
console.log(`✓ Added text element: ${textId}`);
console.log(`✓ Animation: x: 0→500 over 0-3s, y: 100→300 over 0-3s`);
console.log(`✓ FFmpeg will generate piecewise linear expressions`);
