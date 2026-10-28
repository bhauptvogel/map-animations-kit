// geo.mjs — resolve scenes against the optional geo database.
//
// The kit works without any geo data: scenes may use hand-authored
// coordinates only. If you add data/geo/stations/stations.geojson and
// data/geo/lines/<mode>/<slug>.geojson, station and line slugs resolve here.
// A playfield boundary is optional too; without it the outside-mask and
// playfield clipping are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class GeoResolveError extends Error {}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findPlayfield() {
  const p = path.join(ROOT, 'data/geo/boundaries/playfield.geojson');
  return fs.existsSync(p) ? readJSON(p) : null;
}

export function loadGeoDB() {
  const db = {
    stations: new Map(), // slug -> feature
    stationCoord: new Map(), // slug -> [lon, lat]
    stationNames: new Map(), // slug -> name
    lines: new Map(), // slug -> { color, stations, feature, mode }
    playfield: null, // Feature
  };

  const stationsPath = path.join(ROOT, 'data/geo/stations/stations.geojson');
  if (fs.existsSync(stationsPath)) {
    const fc = JSON.parse(fs.readFileSync(stationsPath, 'utf8'));
    for (const f of fc.features || []) {
      const id = f.properties?.id;
      if (!id) continue;
      db.stations.set(id, f);
      db.stationCoord.set(id, f.geometry.coordinates);
      db.stationNames.set(id, f.properties.name || id);
    }
  }

  const linesDir = path.join(ROOT, 'data/geo/lines');
  if (fs.existsSync(linesDir)) {
    for (const mode of fs.readdirSync(linesDir)) {
      const modeDir = path.join(linesDir, mode);
      if (!fs.statSync(modeDir).isDirectory()) continue;
      for (const f of fs.readdirSync(modeDir)) {
        if (!f.endsWith('.geojson')) continue;
        const feature = JSON.parse(fs.readFileSync(path.join(modeDir, f), 'utf8'));
        const id = feature.properties?.id || f.replace(/\.geojson$/, '');
        db.lines.set(id, {
          color: feature.properties?.color,
          stations: feature.properties?.stations || [],
          mode,
          feature,
        });
      }
    }
  }

  db.playfield = findPlayfield();
  return db;
}

// Kept as a hook for projects that want a hard data gate. The kit itself
// renders without a playfield; scenes that reference absent station/line slugs
// still fail in resolveScene().
export function assertRenderReady(_db) {
  return true;
}

// Resolve one scene's slugs into render-ready structures; throws
// GeoResolveError on any unresolvable reference.
export function resolveScene(db, scene) {
  const problems = [];

  const stations = {}; // slug -> [lon, lat]
  const stationNames = {};
  const needStation = (slug, where) => {
    if (stations[slug]) return;
    const c = db.stationCoord.get(slug);
    if (!c) problems.push(`${where}: station "${slug}" not in geo db`);
    else {
      stations[slug] = c;
      stationNames[slug] = db.stationNames.get(slug);
    }
  };

  const lines = {}; // slug -> { color, feature }
  const needLine = (slug, where) => {
    if (lines[slug]) return;
    const l = db.lines.get(slug);
    if (!l) problems.push(`${where}: line "${slug}" not in geo db`);
    else lines[slug] = { color: l.color, feature: l.feature };
  };

  for (const slug of scene.lines || []) needLine(slug, 'lines');
  for (const [i, le] of (scene.lineEntrances || []).entries()) needLine(le.line, `lineEntrances[${i}]`);
  for (const [i, r] of (scene.rides || []).entries()) {
    needLine(r.line, `rides[${i}]`);
    needStation(r.from, `rides[${i}].from`);
    needStation(r.to, `rides[${i}].to`);
  }
  for (const pin of [scene.seekers, scene.hider]) {
    if (!pin) continue;
    // A pin may start on a station slug or a hand-authored coordinate.
    if (pin.start && pin.start.coord !== undefined) continue;
    needStation(pin.start.station, 'pin.start');
    for (const [i, mv] of (pin.moves || []).entries()) {
      if (mv['from-coord'] === undefined) needStation(mv.from, `moves[${i}].from`);
      if (mv['to-coord'] === undefined) needStation(mv.to, `moves[${i}].to`);
    }
  }
  for (const [i, lb] of (scene.labels || []).entries()) needStation(lb.station, `labels[${i}]`);

  if (problems.length) {
    throw new GeoResolveError(`render blocked — unresolvable geo references:\n  ${problems.join('\n  ')}`);
  }

  // Shared exclusion shapes
  const shapes = {};
  for (const [i, ex] of (scene.exclusions || []).entries()) {
    if (typeof ex.shape !== 'string') continue;
    const p = path.join(ROOT, 'scenes/shapes', `${ex.shape}.geojson`);
    if (!fs.existsSync(p)) {
      throw new GeoResolveError(`render blocked: exclusions[${i}] shape "${ex.shape}" → missing scenes/shapes/${ex.shape}.geojson`);
    }
    shapes[ex.shape] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  // Playfield rings (Polygon or MultiPolygon → flat ring array). Optional.
  let playfieldRings = [];
  if (db.playfield) {
    const geom = db.playfield.geometry || db.playfield.features?.[0]?.geometry;
    const polys =
      geom?.type === 'Polygon' ? [geom.coordinates] :
      geom?.type === 'MultiPolygon' ? geom.coordinates : null;
    if (!polys) throw new GeoResolveError('playfield boundary: unsupported geometry type ' + geom?.type);
    playfieldRings = polys.flat();
  }

  return { stations, stationNames, lines, shapes, playfield: db.playfield, playfieldRings };
}
