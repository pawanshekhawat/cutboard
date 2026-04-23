import { execSync } from 'child_process';
import ffprobeStatic from 'ffprobe-static';
import { resolve } from 'path';

const FFPROBE = ffprobeStatic.path;
const OUTPUT = resolve('output/render.mp4');

console.log('Verifying output video...\n');

const out = execSync(`"${FFPROBE}" -v quiet -print_format json -show_format "${OUTPUT}"`, {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const data = JSON.parse(out);
const format = data.format;

console.log(`📹 Output: ${OUTPUT}`);
console.log(`⏱️  Duration: ${format.duration}s (expected: ~4s)`);
console.log(`📊 Bitrate: ${Math.round(parseInt(format.bit_rate) / 1000)} kb/s`);
console.log(`\n✅ Trim test PASSED if duration is ~4.0 seconds (source: 2s→6s)`);
