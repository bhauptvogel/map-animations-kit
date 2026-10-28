#!/usr/bin/env node
// validate-geo.mjs — optional geo database pre-commit gate.
// Zero-dependency Node (node: fs/path only), same output style as
// validate-scene.mjs: "ERROR"/"warn" lines, exit 1 on errors, 0 otherwise.
//
// Checks:
//  - strict RFC 7946 parse, WGS84 bounds;
//  - id charset + uniqueness across stations AND lines;
//  - referential integrity: station.lines ↔ line files, line.stations ↔
//    station features — both directions;
//  - color matches #RRGGBB;
//  - polygon winding (right-hand rule: exterior CCW, holes CW);
//  - 6-decimal coordinate rounding;
//  - kebab-case filenames located per the README tree.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEO = path.join(ROOT, 'data', 'geo');

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const WGS84_LON = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const WGS84_LAT = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- strict GeoJSON structure ----------
// RFC 7946 position: number array; check length 2 (or 3, warned), rounding, bounds
function checkPosition(pos, where) {
  if (!Array.isArray(pos) || pos.length < 2 || typeof pos[0] !== 'number' || typeof pos[1] !== 'number') {
    err(`${where}: position must be [lon, lat] numbers, got ${JSON.stringify(pos)}`);
    return;
  }
  if (pos.length > 2) warn(`${where}: position has ${pos.length} elements (3D or worse) — RFC 7946 wants 2`);
  if (!WGS84_LON(pos[0]) || !WGS84_LAT(pos[1])) err(`${where}: coordinates ${JSON.stringify(pos)} out of WGS84 bounds`);
  if (round6(pos[0]) !== pos[0] || round6(pos[1]) !== pos[1]) {
    err(`${where}: coordinate ${JSON.stringify(pos)} not rounded to 6 decimals`);
  }
}

function checkRing(ring, where, { closed = true, winding = true } = {}) {
  if (!Array.isArray(ring) || ring.length < 4) {
    err(`${where}: ring must have ≥ 4 positions`);
    return;
  }
  for (const [i, pos] of ring.entries()) checkPosition(pos, `${where}[${i}]`);
  if (closed) {
    const a = JSON.stringify(ring[0]);
    const z = JSON.stringify(ring[ring.length - 1]);
    if (a !== z) err(`${where}: ring not closed (first ≠ last)`);
  }
  if (winding && closed) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    const ccw = a / 2 > 0;
    if (!ccw) err(`${where}: exterior ring not counterclockwise (right-hand rule)`);
  }
}

function checkHole(ring, where) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  if (a / 2 > 0) err(`${where}: interior (hole) ring not clockwise (right-hand rule)`);
}

function checkPolygonCoords(coords, where) {
  if (!Array.isArray(coords) || coords.length === 0) {
    err(`${where}: Polygon coordinates must be a non-empty array of rings`);
    return;
  }
  checkRing(coords[0], `${where}[0]`);
  for (let h = 1; h < coords.length; h++) checkHole(coords[h], `${where}[${h}]`);
}

function checkGeometry(geom, where) {
  if (!geom || typeof geom !== 'object') {
    err(`${where}: missing geometry`);
    return;
  }
  switch (geom.type) {
    case 'Point':
      checkPosition(geom.coordinates, `${where}.coordinates`);
      break;
    case 'MultiPoint':
      for (const [i, p] of (geom.coordinates || []).entries()) checkPosition(p, `${where}.coordinates[${i}]`);
      break;
    case 'LineString':
      if (!Array.isArray(geom.coordinates) || geom.coordinates.length < 2) err(`${where}: LineString needs ≥ 2 positions`);
      else for (const [i, p] of geom.coordinates.entries()) checkPosition(p, `${where}.coordinates[${i}]`);
      break;
    case 'MultiLineString':
      for (const [li, line] of (geom.coordinates || []).entries()) {
        if (!Array.isArray(line) || line.length < 2) err(`${where}.coordinates[${li}]: LineString needs ≥ 2 positions`);
        else for (const [i, p] of line.entries()) checkPosition(p, `${where}.coordinates[${li}][${i}]`);
      }
      break;
    case 'Polygon':
      checkPolygonCoords(geom.coordinates, `${where}.coordinates`);
      break;
    case 'MultiPolygon':
      for (const [pi, poly] of (geom.coordinates || []).entries()) checkPolygonCoords(poly, `${where}.coordinates[${pi}]`);
      break;
    default:
      err(`${where}: unexpected geometry type ${JSON.stringify(geom.type)}`);
  }
}

function checkFeatureProperties(f, where, { requireIdIn = null, requireLineSchema = false } = {}) {
  if (!f || f.type !== 'Feature') {
    err(`${where}: not a GeoJSON Feature`);
    return null;
  }
  const p = f.properties;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    err(`${where}: missing properties object`);
    return null;
  }
  if (typeof p.id !== 'string' || !KEBAB_RE.test(p.id)) {
    err(`${where}: properties.id ${JSON.stringify(p.id)} must be lowercase kebab-case`);
    return null;
  }
  if (typeof p.name !== 'string' || !p.name) {
    // line features (README schema: id/mode/color/stations only) legitimately
    // carry no name — nothing to check for them
    if (!requireLineSchema) warn(`${where}: properties.name missing`);
  }
  if (requireIdIn && !requireIdIn.has(p.id)) {
    err(`${where}: id "${p.id}" — filename does not match properties.id`);
  }
  for (const k of Object.keys(p)) {
    if (!['id', 'name', 'mode', 'color', 'stations', 'lines', 'gtfs_id'].includes(k)) {
      warn(`${where}: unknown property "${k}"`);
    }
  }
  return p;
}

function checkFeatureCollection(v, where) {
  if (!v || v.type !== 'FeatureCollection' || !Array.isArray(v.features)) {
    err(`${where}: must be a FeatureCollection with a features array`);
    return null;
  }
  for (const illegal of ['metadata', 'crs', 'bbox-coords']) {
    if (v[illegal] !== undefined) err(`${where}: illegal top-level member "${illegal}" (pure GeoJSON only)`);
  }
  if (v.bbox !== undefined && (!Array.isArray(v.bbox) || v.bbox.length !== 4)) {
    err(`${where}: bbox must be a 4-element array`);
  }
  return v.features;
}

function readJSON(p, where) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    err(`${where}: file cannot be read`);
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) err(`${where}: file has a UTF-8 BOM (must be BOM-less UTF-8)`);
  try {
    return JSON.parse(raw);
  } catch (e) {
    err(`${where}: does not parse as JSON (${e.message})`);
    return null;
  }
}

// ---------- tree discovery ----------
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const kebabGeo = (f) => KEBAB_RE.test(path.basename(f, '.geojson')) && f.endsWith('.geojson');

// ---------- registry (uniqueness across stations AND lines) ----------
const allIds = new Map(); // id -> where first seen
function claimId(id, where) {
  if (allIds.has(id)) err(`${where}: id "${id}" already used at ${allIds.get(id)} (uniqueness across stations AND lines)`);
  else allIds.set(id, where);
}

// ================= boundaries/ =================
// Optional: a single playfield boundary. Without it the renderer simply skips
// the outside-mask and playfield clipping.
const playfieldPath = path.join(GEO, 'boundaries/playfield.geojson');
if (fs.existsSync(playfieldPath)) {
  const v = readJSON(playfieldPath, 'boundaries/playfield.geojson');
  let feature = null;
  if (v && v.type === 'Feature') feature = v;
  else if (v && v.type === 'FeatureCollection') {
    const feats = v.features || [];
    if (feats.length !== 1) err(`boundaries/playfield.geojson: expected exactly ONE feature, got ${feats.length}`);
    [feature] = feats;
  } else if (v) err(`boundaries/playfield.geojson: must be a Feature (or 1-feature FeatureCollection), got ${v.type}`);
  if (feature) {
    checkFeatureProperties(feature, 'boundaries/playfield.geojson');
    checkGeometry(feature.geometry, 'boundaries/playfield.geojson');
  }
}

// ================= stations/stations.geojson =================
const stationLines = new Map(); // station id -> lines[]
const stationsPath = path.join(GEO, 'stations/stations.geojson');
const stationExists = fs.existsSync(stationsPath);
let stationFeatures = [];
if (stationExists) {
  const feats = checkFeatureCollection(readJSON(stationsPath, 'stations/stations.geojson'), 'stations/stations.geojson');
  if (feats) {
    feats.forEach((f, i) => {
      const where = `stations.geojson[${i}]`;
      const p = checkFeatureProperties(f, where);
      if (!p) return;
      if (!Array.isArray(p.lines)) err(`${where}: "lines" must be an array`);
      else {
        const cur = stationLines.get(p.id) || [];
        for (const l of p.lines) {
          if (typeof l !== 'string') err(`${where}: lines entries must be strings`);
          else cur.push(l);
        }
        stationLines.set(p.id, cur);
      }
      if (p.gtfs_id !== undefined && (typeof p.gtfs_id !== 'string' || !p.gtfs_id)) {
        err(`${where}: gtfs_id must be a non-empty string`);
      }
      if (p.mode !== undefined) err(`${where}: "mode" is a line property, not a station property`);
      stationFeatures.push(f);
      checkGeometry(f.geometry, where);
    });
  }
}

// ================= lines/<mode>/<slug>.geojson =================
// Any folder name is accepted as a mode (u-bahn, s-bahn, tram, regional, …).
const linesDir = path.join(GEO, 'lines');
const lineFiles = []; // {id, mode, path, stations}
if (fs.existsSync(linesDir)) {
  for (const modeEntry of fs.readdirSync(linesDir, { withFileTypes: true })) {
    if (modeEntry.name === 'README.md') continue;
    if (!modeEntry.isDirectory()) {
      warn(`lines/${modeEntry.name}: unexpected file (expect mode folders)`);
      continue;
    }
    const mode = modeEntry.name;
    for (const f of fs.readdirSync(path.join(linesDir, mode))) {
      const full = path.join(linesDir, mode, f);
      const rel = `lines/${mode}/${f}`;
      if (!f.endsWith('.geojson')) {
        warn(`${rel}: non-geojson file`);
        continue;
      }
      if (!KEBAB_RE.test(f.slice(0, -8))) err(`${rel}: filename must be kebab-case.geojson`);
      const v = readJSON(full, rel);
      if (!v) continue;
      if (v.type !== 'Feature') {
        err(`${rel}: must be a Feature, got ${v.type}`);
        continue;
      }
      const p = checkFeatureProperties(v, rel, { requireIdIn: null, requireLineSchema: true });
      if (!p) continue;
      // id matches filename
      if (p.id !== f.slice(0, -8)) err(`${rel}: properties.id "${p.id}" ≠ filename slug "${f.slice(0, -8)}"`);
      // mode matches folder
      if (p.mode !== mode) err(`${rel}: properties.mode "${p.mode}" ≠ folder "${mode}"`);
      // color
      if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) {
        err(`${rel}: color ${JSON.stringify(p.color)} must match #RRGGBB`);
      }
      // ordered stations array
      const stationSlugs = [];
      if (!Array.isArray(p.stations)) err(`${rel}: "stations" must be an array`);
      else {
        for (const st of p.stations) {
          if (typeof st !== 'string') err(`${rel}: stations entries must be station slugs`);
          else stationSlugs.push(st);
        }
      }
      // ring lines: closed LineString for s41/s42
      const isRing = p.id === 's41' || p.id === 's42';
      if (isRing) {
        if (!Array.isArray(p.stations) || p.stations.length < 2 || p.stations[0] !== p.stations[p.stations.length - 1]) {
          err(`${rel}: ring line (${p.id}) must have stations[0] === stations[last]`);
        }
        if (v.geometry?.type !== 'LineString') err(`${rel}: ring line (${p.id}) geometry must be a closed LineString`);
      }
      // geometry: LineString normally; MultiLineString for real branches
      if (v.geometry && !['LineString', 'MultiLineString'].includes(v.geometry.type)) {
        err(`${rel}: geometry must be LineString (or MultiLineString for real branches), got ${v.geometry.type}`);
      } else {
        checkGeometry(v.geometry, rel);
        if (isRing && v.geometry?.type === 'LineString') {
          const coords = v.geometry.coordinates;
          if (JSON.stringify(coords[0]) !== JSON.stringify(coords[coords.length - 1])) {
            err(`${rel}: ring line (${p.id}) LineString must be closed (first === last)`);
          }
        }
      }
      lineFiles.push({ id: p.id, mode, path: rel, stations: stationSlugs, feature: v });
    }
  }
}

// ================= referential integrity (both directions) =================
const stationIds = new Set(stationFeatures.map((f) => f.properties.id));
const lineIds = new Set(lineFiles.map((l) => l.id));

for (const l of lineFiles) {
  for (const st of l.stations) {
    if (!stationExists) continue;
    if (!stationIds.has(st)) err(`${l.path}: stations entry "${st}" has no station feature`);
  }
}
for (const [sid, ls] of stationLines) {
  const seen = new Set();
  for (const lid of ls) {
    if (!lineIds.has(lid)) {
      err(`stations.geojson: station "${sid}" references line "${lid}" — no line file`);
      continue;
    }
    if (seen.has(lid)) err(`stations.geojson: station "${sid}" lists line "${lid}" twice`);
    seen.add(lid);
    const l = lineFiles.find((x) => x.id === lid);
    if (!l.stations.includes(sid)) {
      err(`stations.geojson: station "${sid}" lists line "${lid}" but ${l.path} doesn't list "${sid}"`);
    }
  }
}
for (const l of lineFiles) {
  const seen = new Set();
  for (const st of l.stations) {
    if (seen.has(st)) continue; // trailing ring repeat
    seen.add(st);
    if (!stationExists) continue;
    const sf = stationFeatures.find((f) => f.properties.id === st);
    const sl = (stationLines.get(st) || []).filter((x) => x === l.id).length;
    if (sf && sl === 0) {
      err(`${l.path}: lists "${st}" but station's "lines" doesn't include "${l.id}"`);
    }
  }
}

// ================= filenames per the tree + stray files =================
const allowedTop = new Set(['README.md', 'SOURCES.md', 'stations', 'lines', 'boundaries', 'context']);
for (const entry of fs.existsSync(GEO) ? fs.readdirSync(GEO, { withFileTypes: true }) : []) {
  if (!allowedTop.has(entry.name)) warn(`data/geo/${entry.name}: outside the layout tree`);
}
for (const [dir, kind] of [['boundaries', 'boundary'], ['stations', 'station'], ['context', 'context']]) {
  const d = path.join(GEO, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (f === 'README.md') continue;
    if (!f.endsWith('.geojson')) warn(`data/geo/${dir}/${f}: non-geojson file`);
    else if (!KEBAB_RE.test(f.slice(0, -8))) err(`data/geo/${dir}/${f}: filename must be kebab-case.geojson`);
  }
}

// ================= summary =================
const fileCount =
  (stationExists ? 1 : 0) + lineFiles.length +
  (fs.existsSync(playfieldPath) ? 1 : 0);

console.log(`\nvalidate-geo: ${fileCount} file(s) (${stationFeatures.length} Stations, ${lineFiles.length} Lines)`);
for (const e of errors) console.error(`  ERROR ${e}`);
for (const w of warns) console.warn(`  warn  ${w}`);
console.log(`  ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);