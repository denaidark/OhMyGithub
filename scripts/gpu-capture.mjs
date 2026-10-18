import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Exclude CSS borders. A flat-shaded triangle needs only two interior colours;
// a border around a blank canvas must not count as successful rendering.
export function analysePixels({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 10 || height < 10 || data.length !== width * height * 4) {
    throw new Error('Invalid RGBA image dimensions');
  }
  const colors = new Set();
  let sum = 0, square = 0, count = 0;
  for (let y = 4; y < height - 4; y++) for (let x = 4; x < width - 4; x++) {
    const i = (y * width + x) * 4;
    const value = (data[i] + data[i + 1] + data[i + 2]) / 3;
    colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    sum += value; square += value * value; count++;
  }
  const variance = square / count - (sum / count) ** 2;
  return { width, height, distinctInteriorColors: colors.size, variance, nonblank: colors.size > 1 && variance > 1 };
}

export function hasGreenTriangle({ width, height, data }) {
  let green = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255 && data[i + 1] > 150 && data[i] < 80 && data[i + 2] < 130) green++;
  }
  return green / (width * height) > 0.15;
}

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Not a PNG');
  let width, height, channels, pos = 8;
  const chunks = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (chunk.length !== len) throw new Error('Truncated PNG');
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || ![2, 6].includes(chunk[9]) || chunk[12] !== 0) throw new Error('Expected non-interlaced RGB/RGBA PNG');
      channels = chunk[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') chunks.push(chunk);
    if (type === 'IEND') break;
    pos += len + 12;
  }
  if (!width || !height || !channels) throw new Error('Missing PNG header');
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Invalid PNG scanlines');
  const data = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride), offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++], row = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0, b = previous[i], c = i >= channels ? previous[i - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error('Invalid PNG filter');
      row[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, j = x * channels;
      data.set([row[j], row[j + 1], row[j + 2], channels === 4 ? row[j + 3] : 255], i);
    }
    previous = row;
  }
  return { width, height, data };
}

async function step(name, fn) {
  const start = performance.now();
  try { return await fn(); }
  finally { console.log(`${name}: ${((performance.now() - start) / 1000).toFixed(3)}s`); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string', default: '/tmp/chromium-metal-capture' },
    canvas: { type: 'string', default: 'canvas' },
    headless: { type: 'boolean', default: false },
    baseline: { type: 'boolean', default: false },
    'require-green-triangle': { type: 'boolean', default: false },
    executable: { type: 'string' },
    backend: { type: 'string', default: 'metal' },
    'require-metal': { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1 || !/^https?:\/\//.test(positionals[0])) throw new Error('Supply one HTTP(S) game URL');
  const out = path.resolve(values.out);
  await fs.mkdir(out, { recursive: true });
  const require = createRequire(import.meta.url);
  const { chromium } = require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_ROOT || process.cwd()] }));
  const backends = {
    metal: ['--use-angle=metal'],
    vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'],
    swangle: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    swiftshader: ['--use-angle=vulkan', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'],
  };
  if (!backends[values.backend]) throw new Error('Unknown backend');
  const args = values.baseline ? [] : ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', ...backends[values.backend]];
  const report = { url: positionals[0], headless: values.headless, channel: 'chromium', args, startedAt: new Date().toISOString(), console: [], pageErrors: [] };
  let browser;
  try {
    // Full Chromium, not the separate headless shell. Keep GPU sandbox defaults.
    browser = await step('launch', () => chromium.launch({ channel: 'chromium', executablePath: values.executable, headless: values.headless, args, timeout: 30000 }));
    report.browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('console', msg => report.console.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await step('navigate', () => page.goto(positionals[0], { waitUntil: 'load', timeout: 30000 }));
    await page.locator(values.canvas).first().waitFor({ state: 'visible', timeout: 15000 });
    if (values.canvas === '#wgpu') {
      await page.waitForFunction(() => window.__scene?.webgpu?.rendered || !window.__scene, null, { timeout: 15000 });
    }
    report.gpu = await step('adapter probe', () => page.evaluate(async () => {
      const bounded = (p, name) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} timeout`)), 8000))]);
      const result = { secureContext: isSecureContext, hasGpu: !!navigator.gpu };
      const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
      if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); result.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
      try {
        const adapter = navigator.gpu ? await bounded(navigator.gpu.requestAdapter(), 'requestAdapter') : null;
        if (!adapter) { result.error = 'No WebGPU adapter'; return result; }
        const info = adapter.info || await adapter.requestAdapterInfo?.();
        result.adapter = { vendor: info?.vendor, architecture: info?.architecture, device: info?.device, description: info?.description, isFallbackAdapter: info?.isFallbackAdapter ?? adapter.isFallbackAdapter };
        const device = await bounded(adapter.requestDevice(), 'requestDevice');
        result.deviceAvailable = true; device.destroy();
      } catch (error) { result.error = error.message; }
      return result;
    }));
    if (!report.gpu.deviceAvailable) throw new Error(report.gpu.error || 'WebGPU device unavailable');
    if (values['require-metal'] && (report.gpu.adapter?.vendor !== 'apple' || !/ANGLE Metal Renderer/.test(report.gpu.webglRenderer || ''))) throw new Error('Apple Metal adapter not confirmed');
    // Poll screenshot content, not file size or page text. A valid flat triangle
    // has two colours, while a failed canvas with only a CSS border has none.
    const deadline = Date.now() + 15000;
    await step('paint and capture', async () => {
      do {
        const shot = await page.locator(values.canvas).first().screenshot({ timeout: Math.max(1, deadline - Date.now()) });
        const pixels = decodePng(shot);
        report.canvas = analysePixels(pixels);
        if (values['require-green-triangle']) {
          report.canvas.greenTriangle = hasGreenTriangle(pixels);
          report.canvas.nonblank &&= report.canvas.greenTriangle;
        }
        await fs.writeFile(path.join(out, 'canvas.png'), shot);
        if (report.canvas.nonblank) break;
        await page.evaluate(() => new Promise(resolve => {
          setTimeout(resolve, 200);
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        }));
      } while (Date.now() < deadline);
      if (!report.canvas.nonblank) throw new Error('Canvas remained blank within 15s');
      report.scene = await page.evaluate(() => window.__scene || null);
      if (values.canvas === '#wgpu' && report.scene?.webgpu && !report.scene.webgpu.rendered) throw new Error('Fixture WebGPU render did not complete');
      if (report.pageErrors.length) throw new Error('Page reported runtime errors');
      await page.screenshot({ path: path.join(out, 'page.png'), timeout: 15000 });
    });
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error.message; process.exitCode = 1; }
  finally {
    if (browser) await step('close', () => browser.close());
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(out, 'diagnostic.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
