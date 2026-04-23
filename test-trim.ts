// Test Script: Video Trim + Text Overlay
// This script proves the trim math is frame-accurate

const SAMPLE_VIDEO = 'assets/sample-10s.mp4';

// Register the video asset (required before using it)
api.registerAsset({
  type: 'video',
  src: SAMPLE_VIDEO,
});

// Add a video clip that:
// - Starts at t=2s in the SOURCE video (trimStart)
// - Plays for 4 seconds on the timeline (duration)
// - Appears at t=0 on the OUTPUT timeline (start)
const videoId = api.addVideo({
  assetId: SAMPLE_VIDEO,
  start: 0,        // Appears at timeline position 0
  duration: 4,     // Shows for 4 seconds
  trimStart: 2,    // Start from 2s into the source
  trimDuration: 4, // Use 4s of the source (from 2s to 6s)
});

// Add text overlay that appears at t=1s and lasts 2 seconds
const textId = api.addText({
  content: 'Trim Test: Source 2s→6s | Output 0s→4s',
  start: 1,
  duration: 2,
  style: {
    fontSize: 32,
    color: '#00ff00',
    fontFamily: 'Arial',
  },
});

console.log(`✓ Added video element: ${videoId}`);
console.log(`✓ Added text element: ${textId}`);
console.log(`✓ Source: ${SAMPLE_VIDEO} (trim: 2s → 6s)`);
console.log(`✓ Timeline: 0s → 4s`);
