// server.mjs — loopback HTTP server for the render page.
// Serves the repo root at a fixed route; optional PMTiles range requests are
// honored; recipes/recipes.json is injected as /recipes.json; scene + resolved
// geo data are injected as JSON globals the page scripts consume.
// Zero dependencies beyond node:http.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.pmtiles': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

// resolve a URL path to a safe file under root
function resolveSafe(rootDir, urlPath) {
  const p = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(rootDir, p);
  if (!abs.startsWith(rootDir)) return null;
  return abs;
}

export function startServer({ rootDir, port = 0, inject = {}, tilePath }) {
  // inject: { '/__scene.js': 'window.__SCENE_JSON = {...}', ... }
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      let pathname = decodeURIComponent(u.pathname);

      if (inject[pathname]) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(inject[pathname]);
        return;
      }

      // PMTiles with range support (MapLibre pmtiles protocol issues Range reqs)
      if (tilePath && (pathname === '/tiles.pmtiles' || pathname === `/data/tiles/${path.basename(tilePath)}`)) {
        const stat = await fs.promises.stat(tilePath);
        const range = req.headers.range;
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        };
        if (range) {
          const m = range.match(/bytes=(\d*)-(\d*)/);
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
          if (isNaN(start) || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            res.end();
            return;
          }
          if (isNaN(end) || end >= stat.size) end = stat.size - 1;
          const chunk = fs.createReadStream(tilePath, { start, end });
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': end - start + 1,
          });
          chunk.pipe(res);
          return;
        }
        res.writeHead(200, { ...headers, 'Content-Length': stat.size });
        fs.createReadStream(tilePath).pipe(res);
        return;
      }

      // static files from repo root
      let abs = resolveSafe(rootDir, pathname);
      if (!abs || abs === rootDir) abs = path.join(rootDir, 'render/page/index.html');
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`not found: ${pathname}`);
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      const body = fs.createReadStream(abs);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      body.pipe(res);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`server error: ${e.message}`);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}