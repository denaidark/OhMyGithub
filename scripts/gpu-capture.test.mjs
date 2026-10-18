import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Catch the original false failure on a valid two-colour WebGPU triangle,
// and the converse false pass caused by a canvas border around blank content.
let analysePixels;
try { ({ analysePixels } = await import('./gpu-capture.mjs')); } catch {}

function image(fill, paint) {
  const width = 20, height = 20;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb = paint?.(x, y) || fill;
    data.set([...rgb, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}

test('accept a painted two-colour triangle', () => {
  assert.equal(typeof analysePixels, 'function', 'capture classifier must exist');
  const i = image([20, 26, 89], (x, y) => x > 7 && x < 13 && y > 7 ? [26, 230, 89] : null);
  assert.equal(analysePixels(i).nonblank, true);
});

test('reject a uniform canvas even when its border has a second colour', () => {
  assert.equal(typeof analysePixels, 'function', 'capture classifier must exist');
  const i = image([0, 0, 0], (x, y) => x < 2 || y < 2 || x > 17 || y > 17 ? [85, 85, 85] : null);
  assert.equal(analysePixels(i).nonblank, false);
});

test('reject malformed or empty image data', () => {
  assert.equal(typeof analysePixels, 'function', 'capture classifier must exist');
  assert.throws(() => analysePixels({ width: 0, height: 0, data: Buffer.alloc(0) }));
});

test('execute CLI when invoked through a symlink instead of silently succeeding', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gpu-capture-link-'));
  try {
    const link = path.join(dir, 'capture.mjs');
    symlinkSync(fileURLToPath(new URL('./gpu-capture.mjs', import.meta.url)), link);
    const r = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Supply one HTTP\(S\) game URL/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

 test('require green triangle pixels, not background or transparency', async () => {
  const { hasGreenTriangle } = await import('./gpu-capture.mjs');
  assert.equal(hasGreenTriangle(image([0,0,0], (x,y) => x>5 && x<15 ? [26,230,89] : null)), true);
  assert.equal(hasGreenTriangle(image([0,0,0], (x,y) => x>5 ? [24,32,44] : null)), false);
 });
