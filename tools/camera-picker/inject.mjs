// inject.mjs — build the geo injection globals for the camera-picker page
// (window.__GEO_LINES / __PLAYFIELD / __PLAYFIELD_RINGS), shared by server.mjs.
// Same inject pattern render/server.mjs uses for scene + geo.

import fs from 'node:fs';
import path from 'node:path';

export function buildInject(ROOT) {
  // lines: slug → { color, feature } — same shape render/geo.mjs resolves
  const lines = {};
  const linesDir = path.join(ROOT, 'data/geo/lines');
  if (fs.existsSync(linesDir)) {
    for (const mode of fs.readdirSync(linesDir)) {
      const modeDir = path.join(linesDir, mode);
      if (!fs.statSync(modeDir).isDirectory()) continue;
      for (const f of fs.readdirSync(modeDir)) {
        if (!f.endsWith('.geojson')) continue;
        const feature = JSON.parse(fs.readFileSync(path.join(modeDir, f), 'utf8'));
        const id = feature.properties?.id || f.replace(/\.geojson$/, '');
        lines[id] = { color: feature.properties?.color, feature };
      }
    }
  }

  // Optional playfield: Polygon/MultiPolygon → flat ring array.
  let playfield = null;
  let playfieldRings = [];
  const playfieldPath = path.join(ROOT, 'data/geo/boundaries/playfield.geojson');
  if (fs.existsSync(playfieldPath)) {
    playfield = JSON.parse(fs.readFileSync(playfieldPath, 'utf8'));
    const g = playfield.geometry || playfield.features?.[0]?.geometry;
    const polys = g?.type === 'Polygon' ? [g.coordinates]
      : g?.type === 'MultiPolygon' ? g.coordinates : [];
    playfieldRings = polys.flat();
  }

  return {
    '/tools/camera-picker/page/inject.js':
      'window.__GEO_LINES = ' + JSON.stringify(lines) + ';\n' +
      'window.__PLAYFIELD = ' + JSON.stringify(playfield) + ';\n' +
      'window.__PLAYFIELD_RINGS = ' + JSON.stringify(playfieldRings) + ';\n',
  };
}
