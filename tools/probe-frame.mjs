#!/usr/bin/env node
// probe-frame.mjs — render selected frames of a scene to a local directory
// WITHOUT the full frame loop and WITHOUT the output volume (the loopback
// server and hosted or local tiles are enough). Framing/element self-review before
// committing to a full render; the same page, camera law, and paint order as
// render.mjs (determinism: one settle per frame, never once('idle')).
//
// Usage: node tools/probe-frame.mjs <scene.json> <frame>[,<frame>…] [--out=DIR] [--px=x,y[,x,y…]] [--camera=lon,lat,zoom]
//   --out  output dir (default /tmp/probe-<stem>; PNGs at 1920×1080)
//   --px   after the last probed frame, unproject these screen px against the
//          page's live camera and print lon/lat (street-position measuring)
//   --camera  temporary camera override (jumpTo after __frame) — CAVEAT: only
//          the WebGL basemap follows it; the stripe canvas keeps the scene
//          camera's drawing (exclusion stripes, rides, paths), so canvas
//          elements will look misplaced under this camera. Use for basemap/
//          street inspection only.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../render/server.mjs';
import { loadGeoDB, resolveScene, assertRenderReady } from '../render/geo.mjs';
import { deepTimes } from '../render/deep-times.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const argv = process.argv.slice(2);
const sceneArg = argv.find((a) => !a.startsWith('--'));
const framesArg = argv.find((a) => /^\d+(,\d+)*$/.test(a));
const outArg = argv.find((a) => a.startsWith('--out='));
const pxArg = argv.find((a) => a.startsWith('--px='));
const camArg = argv.find((a) => a.startsWith('--camera='));
if (!sceneArg || !framesArg) {
  console.error('usage: node tools/probe-frame.mjs <scene.json> <frame>[,<frame>…] [--out=DIR] [--px=x,y[,x,y…]]');
  process.exit(2);
}
const scenePath = path.resolve(sceneArg);
if (!fs.existsSync(scenePath)) {
  console.error(`HARD ERROR: scene not found: ${scenePath}`);
  process.exit(2);
}
const sceneRaw = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
const scene = deepTimes(sceneRaw);
const stem = path.basename(scenePath, '.json');
const frames = framesArg.split(',').map(Number);
const outDir = path.resolve(outArg ? outArg.slice(6) : `/tmp/probe-${stem}`);
fs.mkdirSync(outDir, { recursive: true });

// geo + validation (same gates as render.mjs)
const { spawnSync } = await import('node:child_process');
const validation = spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-scene.mjs'), scenePath], {
  cwd: ROOT, encoding: 'utf8',
});
if (validation.status !== 0) {
  console.error(`HARD ERROR: scene fails validation:\n${(validation.stderr || '').trim()}`);
  console.error('Probe refused — fix the scene first (node scripts/validate-scene.mjs).');
  process.exit(2);
}
const db = loadGeoDB();
assertRenderReady(db);
const resolved = resolveScene(db, scene);

const geoForPage = {
  stations: resolved.stations,
  stationNames: resolved.stationNames,
  lines: resolved.lines,
};
const inject = {
  '/render/inject.js': [
    `window.__SCENE_JSON = ${JSON.stringify(scene)};`,
    `window.__GEO = ${JSON.stringify(geoForPage)};`,
    `window.__SHAPES = ${JSON.stringify(resolved.shapes)};`,
    `window.__PLAYFIELD = ${JSON.stringify(resolved.playfield)};`,
    `window.__PLAYFIELD_RINGS = ${JSON.stringify(resolved.playfieldRings)};`,
    `window.__RECIPES = ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'recipes/recipes.json'), 'utf8')))};`,
    `window.__RENDER_META = ${JSON.stringify({ stem, scenePath, probe: true })};`,
  ].join('\n'),
};

function findTilePath() {
  if (process.env.MAP_TILES_PMTILES) return path.resolve(process.env.MAP_TILES_PMTILES);
  const dir = path.join(ROOT, 'data/tiles');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((name) => name.endsWith('.pmtiles'));
  return f ? path.join(dir, f) : null;
}
const tilePath = findTilePath();

const server = await startServer({ rootDir: ROOT, port: 0, inject, tilePath });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
log(`loopback server at ${baseUrl}`);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--allow-file-access-from-files'],
});
const framing = sceneRaw.scene.framing;
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 300)); });

await page.goto(`${baseUrl}/render/page/index.html?framing=${framing}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__map !== undefined, null, { timeout: 15000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
await page.waitForFunction(() => window.__geoReady === true, null, { timeout: 20000 });

await page.evaluate(() => window.__frame(0));
await page.evaluate(() => window.__settle());

for (const f of frames) {
  await page.evaluate((fr) => window.__frame(fr), f);
  if (camArg) {
    const [lon, lat, zoom] = camArg.slice(9).split(',').map(Number);
    await page.evaluate((c) => window.__map.jumpTo({ center: c, zoom: c[2] }), [lon, lat, zoom]);
  }
  if (argv.includes('--debug-paths')) {
    // draw the expected path polylines INSIDE the page (map.project — zero
    // external math) to verify where drawPath lands them
    await page.evaluate(() => {
      const sc = window.__SCENE_JSON;
      let cv = document.getElementById('__dbg');
      if (cv) cv.remove();
      cv = document.createElement('canvas');
      cv.id = '__dbg';
      cv.width = 1920; cv.height = 1080;
      cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:50';
      document.getElementById('slide-wrap').appendChild(cv);
      const g = cv.getContext('2d');
      g.strokeStyle = 'rgba(255,0,255,0.9)';
      g.lineWidth = 2;
      for (const pa of sc.paths || []) {
        g.beginPath();
        pa.resolvedCoords.forEach((ll, i) => {
          const p = window.__map.project(ll);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        });
        g.stroke();
        pa.resolvedCoords.forEach((ll, i) => {
          const p = window.__map.project(ll);
          g.beginPath();
          g.arc(p.x, p.y, 4, 0, 2 * Math.PI);
          g.fillStyle = i === 0 ? 'rgba(0,200,0,0.9)' : 'rgba(255,0,0,0.9)';
          g.fill();
        });
      }
      for (const r of sc.rides || []) {
        if (!r.resolvedCoords || r.alpha <= 0) continue;
        g.strokeStyle = 'rgba(0,120,255,0.9)';
        g.beginPath();
        r.resolvedCoords.forEach((ll, i) => {
          const p = window.__map.project(ll);
          if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
        });
        g.stroke();
        const pA = window.__map.project(r.resolvedCoords[0]);
        const pB = window.__map.project(r.resolvedCoords[r.resolvedCoords.length - 1]);
        g.fillStyle = 'rgba(0,120,255,0.9)';
        g.beginPath(); g.arc(pA.x, pA.y, 5, 0, 2 * Math.PI); g.fill();
        g.beginPath(); g.arc(pB.x, pB.y, 5, 0, 2 * Math.PI); g.fill();
      }
    });
  }
  await page.evaluate(() => window.__settle());
  const p = path.join(outDir, `${stem}-f${String(f).padStart(4, '0')}${camArg ? '-cam' : ''}.png`);
  await page.screenshot({ path: p, omitBackground: framing !== 'full' });
  log(`frame ${f} → ${p}`);
}

if (pxArg) {
  const pxs = pxArg.slice(6).split(',').map((s) => s.split('x').map(Number));
  for (const [x, y] of pxs) {
    const ll = await page.evaluate(([px, py]) => window.__map.unproject([px, py]), [x, y]);
    console.log(`px ${x},${y} → [${ll.lng.toFixed(6)}, ${ll.lat.toFixed(6)}]`);
  }
}

if (argv.includes('--dump')) {
  const lastS = frames[frames.length - 1] / 24;
  const state = await page.evaluate((s) => {
    const sc = window.__SCENE_JSON;
    const round = (ll) => ll.map((v) => Number(v.toFixed(6)));
    const pins = {};
    for (const k of ['seekers', 'hider']) {
      if (sc[k]) {
        const pos = window.__interp.pinPosition(sc[k], s);
        pins[k] = pos.coord ? round(pos.coord) : null;
      }
    }
    return {
      camera: (() => { const c = window.__map.getCenter(); return [Number(c.lng.toFixed(6)), Number(c.lat.toFixed(6)), Number(window.__map.getZoom().toFixed(3))]; })(),
      rides: (sc.rides || []).map((r) => ({
        id: `${r.from}→${r.to} (${r.line})`, alpha: r.alpha,
        n: r.resolvedCoords ? r.resolvedCoords.length : 0,
        first: r.resolvedCoords && r.resolvedCoords[0] ? round(r.resolvedCoords[0]) : null,
        last: r.resolvedCoords && r.resolvedCoords.length ? round(r.resolvedCoords[r.resolvedCoords.length - 1]) : null,
      })),
      paths: (sc.paths || []).map((p) => ({
        alpha: p.alpha, progress: p.progress,
        n: p.resolvedCoords ? p.resolvedCoords.length : 0,
        first: p.resolvedCoords && p.resolvedCoords[0] ? round(p.resolvedCoords[0]) : null,
        last: p.resolvedCoords && p.resolvedCoords.length ? round(p.resolvedCoords[p.resolvedCoords.length - 1]) : null,
      })),
      pins,
    };
  }, lastS);
  console.log('--- page state @ last probed frame ---');
  console.log(JSON.stringify(state, null, 2));
}

await browser.close();
server.close();
process.exit(0);
