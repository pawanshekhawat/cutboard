import { execSync } from 'child_process';
import { existsSync, mkdirSync, statSync } from 'fs';
import { resolve } from 'path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { Project } from '../src/types/schema.js';
import { SCHEMA_VERSION } from '../src/types/schema.js';
import { render } from '../src/engine/render.js';

const FFMPEG = ffmpegStatic as unknown as string;
const FFPROBE = ffprobeStatic.path;

const ROOT = '.';
const IMAGE_SRC = 'assets/smoke-image.png';
const OUTPUT = 'output/smoke-image-render.mp4';

function ensureSmokeImage() {
  const abs = resolve(ROOT, IMAGE_SRC);
  if (existsSync(abs)) return;
  mkdirSync(resolve(ROOT, 'assets'), { recursive: true });
  execSync(
    `"${FFMPEG}" -y -f lavfi -i "color=c=orange:s=640x360:d=1" -frames:v 1 "${abs}"`,
    { stdio: 'inherit' }
  );
}

function probeDurationSeconds(absVideoPath: string): number {
  const out = execSync(`"${FFPROBE}" -v quiet -print_format json -show_format "${absVideoPath}"`, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const data = JSON.parse(out);
  return Number.parseFloat(String(data?.format?.duration || '0'));
}

function buildSmokeProject(): Project {
  return {
    version: SCHEMA_VERSION,
    meta: {
      name: 'B3 Image Smoke',
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      duration: 4,
    },
    assets: {
      [IMAGE_SRC]: {
        type: 'image',
        src: IMAGE_SRC,
      },
    },
    tracks: [],
    elements: {
      el_image_smoke: {
        id: 'el_image_smoke',
        type: 'image',
        assetId: IMAGE_SRC,
        start: 0.5,
        duration: 3,
        trimStart: 0,
        trimDuration: 3,
        transform: {
          x: 300,
          y: 220,
          scale: 0.7,
          rotation: 0,
          opacity: 1,
        },
      },
    },
    animations: {
      anim_image_x_0: {
        id: 'anim_image_x_0',
        target: 'el_image_smoke',
        property: 'transform.x',
        keyframes: [{ id: 'kf_image_x_0', time: 0.5, value: 300 }],
        easing: 'linear',
      },
      anim_image_x_1: {
        id: 'anim_image_x_1',
        target: 'el_image_smoke',
        property: 'transform.x',
        keyframes: [{ id: 'kf_image_x_1', time: 3.3, value: 1500 }],
        easing: 'linear',
      },
      anim_image_rot_0: {
        id: 'anim_image_rot_0',
        target: 'el_image_smoke',
        property: 'transform.rotation',
        keyframes: [{ id: 'kf_image_rot_0', time: 0.5, value: 0 }],
        easing: 'linear',
      },
      anim_image_rot_1: {
        id: 'anim_image_rot_1',
        target: 'el_image_smoke',
        property: 'transform.rotation',
        keyframes: [{ id: 'kf_image_rot_1', time: 3.3, value: 25 }],
        easing: 'linear',
      },
    },
    effects: {},
  };
}

function main() {
  ensureSmokeImage();
  const project = buildSmokeProject();
  render(project, OUTPUT, ROOT);

  const absOutput = resolve(ROOT, OUTPUT);
  if (!existsSync(absOutput)) {
    throw new Error(`Smoke render failed: output not found at ${absOutput}`);
  }
  const size = statSync(absOutput).size;
  if (size <= 0) {
    throw new Error('Smoke render failed: output file is empty');
  }
  const duration = probeDurationSeconds(absOutput);
  if (!(duration > 3.5 && duration < 4.5)) {
    throw new Error(`Smoke render failed: unexpected duration ${duration}s`);
  }

  console.log(`✓ B3 image smoke passed: ${OUTPUT}`);
}

main();
