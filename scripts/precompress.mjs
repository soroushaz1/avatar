// Writes Brotli-compressed copies of the large browser assets into precompressed/, plus a manifest of
// their original sizes. Run at deploy time (after `npm ci`); the server serves them to browsers that
// accept Brotli, which cuts the first-visit download by about a third compared to on-the-fly gzip.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'precompressed');
const brotli = promisify(zlib.brotliCompress);

const MP = 'node_modules/@mediapipe/tasks-vision';
const FILES = {
  '/vendor/mediapipe/vision_bundle.mjs': `${MP}/vision_bundle.mjs`,
  '/vendor/mediapipe/wasm/vision_wasm_internal.js': `${MP}/wasm/vision_wasm_internal.js`,
  '/vendor/mediapipe/wasm/vision_wasm_internal.wasm': `${MP}/wasm/vision_wasm_internal.wasm`,
  '/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js': `${MP}/wasm/vision_wasm_nosimd_internal.js`,
  '/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm': `${MP}/wasm/vision_wasm_nosimd_internal.wasm`,
  '/vendor/three/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/delaunator/delaunator.min.js': 'node_modules/delaunator/delaunator.min.js',
  '/models/face_landmarker.task': 'public/models/face_landmarker.task',
};

const manifest = {};
await Promise.all(Object.entries(FILES).map(async ([url, src]) => {
  const data = await fs.readFile(path.join(ROOT, src));
  const compressed = await brotli(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  const dest = path.join(OUT, `${url}.br`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, compressed);
  manifest[url] = data.length;
  console.log(`${url}: ${data.length} -> ${compressed.length} bytes`);
}));
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
