#!/usr/bin/env node
// render.mjs — per-scene driver: scene JSON → frames → encode.
// Usage: node render/render.mjs <scene.json> [--framing=full|half|half-bottom|half-right]
//        [--keep-frames] [--port=N]
// Output goes to ./renders/ by default (override with MAP_RENDER_OUT). Frames
// live in a temp working area and are deleted after a successful encode
// (unless --keep-frames, for debugging).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { loadGeoDB, resolveScene, assertRenderReady, GeoResolveError } from './geo.mjs';
import { validateForRender } from './validate-for-render.mjs';
import { tc2sec, deepTimes } from './deep-times.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FPS = 24;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- output root ----------------
function outputRoot() {
  if (process.env.MAP_RENDER_OUT) return path.resolve(process.env.MAP_RENDER_OUT);
  return path.join(ROOT, 'renders');
}

// ---------------- cli ----------------
const argv = process.argv.slice(2);
const sceneArg = argv.find((a) => !a.startsWith('--'));
if (!sceneArg) {
  console.error('usage: node render/render.mjs <scene.json> [--framing=full|half|half-bottom|half-right] [--keep-frames] [--port=N]');
  process.exit(2);
}
const scenePath = path.resolve(sceneArg);
const framingArg = argv.find((a) => a.startsWith('--framing='));
const keepFrames = argv.includes('--keep-frames');
const portArg = argv.find((a) => a.startsWith('--port='));

// ---------------- load scene + geo ----------------
if (!fs.existsSync(scenePath)) {
  console.error(`HARD ERROR: scene not found: ${scenePath}`);
  process.exit(2);
}
const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const stem = path.basename(scenePath, '.json');

// 1) validation gate: a scene that fails validation does not render (§7.1)
const validation = validateForRender(ROOT, scenePath);
if (validation.errors.length) {
  console.error(`HARD ERROR: scene fails validation (docs/scene-format.md contract):`);
  for (const e of validation.errors) console.error(`  ERROR ${e}`);
  console.error('Run: node scripts/validate-scene.mjs ' + scenePath);
  process.exit(2);
}

// 2) geo resolution (geo-ghost: hard-error absent boundary, §4)
const db = loadGeoDB();
let resolved;
try {
  assertRenderReady(db);
  resolved = resolveScene(db, scene);
} catch (e) {
  if (e instanceof GeoResolveError) {
    console.error(`HARD ERROR: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

// 3) map framings to variants (§7.3) — one scene = one framing (§1): the
// scene's framing drives the page; `--framing` must select exactly that
// variant (or default to it). Rendering the other framing from a scene whose
// framing disagrees would capture a full map into the half mask.
const framings = framingArg
  ? framingArg.slice(10).split(',')
  : [scene.scene.framing];
if (framings.length !== 1 || framings[0] !== scene.scene.framing) {
  console.error(
    `HARD ERROR: scene framing is "${scene.scene.framing}" — one scene = one framing (spec §1). ` +
    `Render exactly that: --framing=${scene.scene.framing} (or render the matching scene file).`
  );
  process.exit(2);
}
  const variants = framings.map((f) =>
    f === 'full'
      ? { name: 'full', viewport: { width: 1920, height: 1080 }, omitBackground: false }
      : f === 'half'
        ? { name: 'half', viewport: { width: 1920, height: 1080 }, omitBackground: true }
        : f === 'half-bottom'
          ? { name: 'half-bottom', viewport: { width: 1920, height: 1080 }, omitBackground: true }
          : f === 'half-right'
            ? { name: 'half-right', viewport: { width: 1920, height: 1080 }, omitBackground: true }
            : null
  );
if (variants.some((v) => v === null)) {
  console.error(`HARD ERROR: --framing must be full|half|half-bottom|half-right (got "${framingArg?.slice(10)}")`);
  process.exit(2);
}

// All outputs land flat in the output directory, no per-scene subfolder.
const outDir = outputRoot();
fs.mkdirSync(outDir, { recursive: true });

// inject script globals: scene, resolved geo, recipes
const geoForPage = {
  stations: resolved.stations,
  stationNames: resolved.stationNames,
  lines: resolved.lines,
};
// convert scene timecodes to seconds once, here — the page works in seconds
// (shared helpers in deep-times.mjs)
const scenePage = deepTimes(scene);

const inject = {
  '/render/inject.js': [
    `window.__SCENE_JSON = ${JSON.stringify(scenePage)};`,
    `window.__GEO = ${JSON.stringify(geoForPage)};`,
    `window.__SHAPES = ${JSON.stringify(resolved.shapes)};`,
    `window.__PLAYFIELD = ${JSON.stringify(resolved.playfield)};`,
    `window.__PLAYFIELD_RINGS = ${JSON.stringify(resolved.playfieldRings)};`,
    `window.__RECIPES = ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'recipes/recipes.json'), 'utf8')))};`,
    `window.__RENDER_META = ${JSON.stringify({ stem, scenePath })};`,
  ].join('\n'),
};

// ---------------- loopback server (fixed route per run) ----------------
// Local PMTiles is optional. The shipped style uses hosted OpenFreeMap tiles;
// if you switch style.json to a pmtiles:// source, drop the extract in
// data/tiles/ and it is served automatically.
function findTilePath() {
  if (process.env.MAP_TILES_PMTILES) return path.resolve(process.env.MAP_TILES_PMTILES);
  const dir = path.join(ROOT, 'data/tiles');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((name) => name.endsWith('.pmtiles'));
  return f ? path.join(dir, f) : null;
}
const tilePath = findTilePath();

const port = portArg ? Number(portArg.slice(7)) : 0;
const server = await startServer({ rootDir: ROOT, port, inject, tilePath });
const addr = server.address();
const baseUrl = `http://127.0.0.1:${addr.port}`;
log(`loopback server at ${baseUrl}`);

// ---------------- render ----------------
const framesWorkDir = path.join(os.tmpdir(), `map-animations-frames-${stem}`);
const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--allow-file-access-from-files'],
});

function encode(framesDir, variant, outPath) {
  // §2 encode command (ProRes 4444 yuva444p10le)
  const args = ['-y', '-framerate', String(FPS), '-start_number', '0',
    '-i', path.join(framesDir, 'frame_%05d.png'),
    '-c:v', 'prores_ks', '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le', '-alpha_bits', '16',
    outPath];
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

let ok = true;
for (const variant of variants) {
  const framesDir = path.join(framesWorkDir, variant.name);
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const pageUrl = `${baseUrl}/render/page/index.html?framing=${variant.name}`;
  const ctx = await browser.newContext({
    viewport: variant.viewport,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 300)); });

  log(`[${variant.name}] loading page…`);
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__map !== undefined, null, { timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForFunction(() => window.__geoReady === true, null, { timeout: 20000 });

  const lengthSec = (() => {
    const m = scene.scene.length.match(/^(?:(\d+):)?(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) throw new Error(`scene.length unparseable: ${scene.scene.length}`);
    const [, hh, mm, ss, ff] = m;
    return ((Number(hh || 0) * 60 + Number(mm)) * 60 + Number(ss)) + Number(ff) / 24;
  })();
  const totalFrames = Math.round(lengthSec * FPS);

  // warm-up: first frame + settle before timing
  await page.evaluate(() => window.__frame(0));
  await page.evaluate(() => window.__settle());

  const times = [];
  for (let f = 0; f < totalFrames; f++) {
    const t0 = Date.now();
    await page.evaluate((fr) => window.__frame(fr), f);
    await page.evaluate(() => window.__settle());
    await page.screenshot({
      path: path.join(framesDir, `frame_${String(f).padStart(5, '0')}.png`),
      omitBackground: variant.omitBackground,
      timeout: 15000,
    });
    times.push(Date.now() - t0);
    if (f % 48 === 0 || f === totalFrames - 1) log(`  [${variant.name}] frame ${f}/${totalFrames - 1} (${times[times.length - 1]}ms)`);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const max = Math.max(...times);
  log(`[${variant.name}] capture done: ${totalFrames} frames, avg ${avg.toFixed(0)}ms, max ${max}ms`);

  const movPath = path.join(outDir, `${stem}-${variant.name}.mov`);
  encode(framesDir, variant, movPath);
  // render log (§9) — stem-prefixed so flat files don't collide
  fs.writeFileSync(path.join(outDir, `render-log-${stem}-${variant.name}.json`), JSON.stringify({
    scene: stem, variant: variant.name, frames: totalFrames,
    avgMs: avg, maxMs: max, times,
  }, null, 2));

  if (!keepFrames) {
    fs.rmSync(framesDir, { recursive: true, force: true });
  } else {
    log(`[${variant.name}] frames kept at ${framesDir} (--keep-frames)`);
  }

  await ctx.close();
  log(`[${variant.name}] → ${movPath}`);
}

await browser.close();
server.close();
log(ok ? 'all framings rendered' : 'completed with errors');
process.exit(ok ? 0 : 1);