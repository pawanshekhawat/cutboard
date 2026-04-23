import { execSync } from 'child_process';
const FFMPEG = 'D:\\Coding\\Projects\\cutboard\\node_modules\\ffmpeg-static\\ffmpeg.exe';
const SRC = 'D:\\Coding\\Projects\\cutboard\\test-project\\assets\\clip.mp4';

let out = '';
try {
  out = execSync(`cmd /c "\"${FFMPEG}\" -i \"${SRC}\" 2>&1"`, {
    encoding: 'utf-8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('success, len=', out.length, 'first300:', out.slice(0, 300));
} catch (err: any) {
  out = String(err.stderr ?? '');
  console.log('catch, len=', out.length, 'first300:', out.slice(0, 300));
  const m = out.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (m) {
    const dur = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
    console.log('parsed duration:', dur);
  }
}