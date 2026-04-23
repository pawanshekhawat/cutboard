import { execSync } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';

const FFMPEG = ffmpegStatic as unknown as string;
const OUTPUT = 'assets/sample-10s.mp4';

console.log('Generating 10s test video with visible timestamp...');

// Create a test video with a counter that shows the current second
// This makes it easy to verify trim accuracy visually
const cmd = `"${FFMPEG}" -y -f lavfi -i "testsrc2=duration=10:size=1920x1080:rate=30" -vf "drawtext=text='%{eif t:d}s':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -crf 18 -preset fast "${OUTPUT}"`;

execSync(cmd, { stdio: 'inherit' });
console.log(`✓ Generated: ${OUTPUT}`);
