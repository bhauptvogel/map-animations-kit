// server.mjs — loopback server for the camera-picker tool page.
// Serves the repo root (style.json, optional geo db, optional tiles,
// node_modules) plus the tool's page/, mirroring render/server.mjs: optional
// PMTiles with HTTP range support, geo data injected as globals the page
// consumes.
// Usage: node tools/camera-picker/server.mjs [--port=N] [--no-open]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../render/server.mjs';
import { buildInject } from './inject.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOL_DIR, '..', '..');

function findTilePath() {
  if (process.env.MAP_TILES_PMTILES) return path.resolve(process.env.MAP_TILES_PMTILES);
  const dir = path.join(ROOT, 'data/tiles');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((name) => name.endsWith('.pmtiles'));
  return f ? path.join(dir, f) : null;
}
const tilePath = findTilePath();

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice(7)) : 8123;
const noOpen = process.argv.includes('--no-open');

const inject = buildInject(ROOT);
const server = await startServer({ rootDir: ROOT, port, tilePath, inject });
const addr = server.address();
const url = `http://127.0.0.1:${addr.port}/tools/camera-picker/page/index.html`;

console.log(`camera-picker → ${url}`);
if (!noOpen) {
  const open = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  const { execFile } = await import('node:child_process');
  execFile(open, [url], () => {});
}
