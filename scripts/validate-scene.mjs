#!/usr/bin/env node
// validate-scene.mjs — scene pre-commit gate (docs/scene-format.md contract).
// Zero-dependency (the validate-geo.mjs pattern). Errors block, warnings never.
// Recipe-name/override checks run against recipes/recipes.json (§8, errors).
// Slug resolution (stations/lines/shapes) needs data/geo/ — geo-ghost aware:
// when the geo db is absent, slug checks degrade to warnings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FRAMING_VALUES = ['full', 'half', 'half-bottom', 'half-right'];
// Filename convention: <video>[-intro]-<nn>-<slug>.json. <video> is any
// lowercase slug, so one kit can host several series or projects.
const VIDEO_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(?:intro-)?(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const ALLOWED_EXCLUSION_SHAPES = ['Polygon', 'MultiPolygon'];
const WINDOW_CARRIERS = {
  'camera.at': true,
  'exclusions[].entry': true,
  'rides[]': true,
  'moves[]': true,
  'labels[]': true,
};
// deep unknown-field map (the versioning mechanism) — top-level + per element
const TOP_LEVEL_KEYS = ['scene', 'camera', 'streets', 'lines', 'lineEntrances', 'exclusions', 'rides', 'seekers', 'hider', 'labels', 'points', 'segments', 'paths', 'circles', 'slideWindow'];
const SCHEMA = {
  scene: ['video', 'nn', 'title', 'length', 'framing'],
  camera: ['waypoints', 'overrides'],
  waypoint: ['at', 'center', 'zoom', 'bearing', 'pitch'],
  lines: null, // array of strings
  lineEntrance: ['line', 'window', 'overrides'],
  exclusion: ['id', 'shape', 'entry'],
  entry: ['recipe', 'window', 'overrides'],
  ride: ['line', 'from', 'to', 'window', 'overrides'],
  seekers: ['photo', 'start', 'moves', 'window', 'overrides', 'tilt'],
  hider: ['photo', 'start', 'moves', 'window', 'overrides', 'tilt'],
  start: ['station', 'coord'],
  move: ['from', 'to', 'from-coord', 'to-coord', 'window', 'overrides', 'line'],
  label: ['station', 'line', 'window', 'overrides', 'dot-only', 'grow', 'grow-at', 'pulse', 'pulse-at', 'dot-scale', 'label-scale', 'label-side', 'label-dy'],
  point: ['coord', 'text', 'window', 'overrides', 'label-side', 'label-dy', 'color', 'scale'],
  segment: ['coords', 'window', 'overrides'],
  path: ['coords', 'window', 'overrides', 'color', 'append'],
  circle: ['center', 'radius-m', 'window', 'overrides'],
};

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

// ------- cli -------
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const sceneDirArg = args.find((a) => a.startsWith('--scenes='));
let targets = [];
if (files.length) targets = files;
else {
  const dir = sceneDirArg ? path.resolve(ROOT, sceneDirArg.slice(9)) : path.join(ROOT, 'scenes');
  if (fs.existsSync(dir)) {
    targets = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(dir, f));
  }
}
if (!targets.length) {
  console.log('usage: node scripts/validate-scene.mjs [scene.json ...] [--scenes=DIR]');
  console.log('  validates every scenes/*.json (or the given files) against the scene-format contract');
  process.exit(0);
}

// ------- geo db (geo-ghost aware) -------
function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const stationsPath = path.join(ROOT, 'data/geo/stations/stations.geojson');
const playfieldBoundary = path.join(ROOT, 'data/geo/boundaries/playfield.geojson');
const geoPresent = fs.existsSync(playfieldBoundary) || fs.existsSync(stationsPath);
const stations = new Map(); // slug -> feature
if (fs.existsSync(stationsPath)) {
  const fc = readJSON(stationsPath);
  if (fc && fc.type === 'FeatureCollection') {
    for (const f of fc.features || []) {
      if (f && f.properties && f.properties.id) stations.set(f.properties.id, f);
      else err(`stations.geojson: feature without properties.id`);
    }
  } else {
    err(`stations.geojson exists but does not parse as a FeatureCollection`);
  }
}

function findLine(slug) {
  // data/geo/lines/<mode>/<slug>.geojson
  const base = path.join(ROOT, 'data/geo/lines');
  if (!fs.existsSync(base)) return null;
  for (const mode of fs.readdirSync(base)) {
    const p = path.join(base, mode, `${slug}.geojson`);
    if (fs.existsSync(p)) return readJSON(p);
  }
  return null;
}

// ------- recipe registry (exists → checks are errors) -------
const registryPath = path.join(ROOT, 'recipes/recipes.json');
const registry = readJSON(registryPath);
const registryActive = !!registry;

function recipeFor(name) {
  return registry && Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;
}

const unknownRecipeReported = new Set();
function checkOverrides(carrier, recipeName, where) {
  if (registryActive) {
    const r = recipeFor(recipeName);
    if (!r) {
      const key = `${where}::${recipeName}`;
      if (!unknownRecipeReported.has(key)) {
        unknownRecipeReported.add(key);
        err(`${where}: unknown recipe "${recipeName}" (not in recipes/recipes.json)`);
      }
      return;
    }
    const ov = carrier.overrides || {};
    for (const [k, v] of Object.entries(ov)) {
      const p = r.params && r.params[k];
      if (!p) {
        err(`${where}: unknown override key "${k}" for recipe "${recipeName}"`);
        continue;
      } else if (p.type === 'number' && typeof v !== 'number') {
        err(`${where}: override "${k}" must be a number (recipe "${recipeName}")`);
      } else if (p.type === 'boolean' && typeof v !== 'boolean') {
        err(`${where}: override "${k}" must be a boolean (recipe "${recipeName}")`);
      } else if (p.type === 'enum') {
        if (typeof v !== 'string' || !p.values || !p.values.includes(v)) {
          err(
            `${where}: override "${k}" must be one of ${JSON.stringify(p.values || [])} (recipe "${recipeName}")`
          );
        }
      }
      if (
        p.type === 'number' && typeof v === 'number' &&
        typeof p.min === 'number' && typeof p.max === 'number'
      ) {
        if (v < p.min || v > p.max) {
          err(`${where}: override "${k}" must be between ${p.min} and ${p.max} (recipe "${recipeName}")`);
        }
      }
    }
    // blink law window check (spec §8 / recipes README): warn when too short
    if (recipeName === 'blink-then-stay' && r.params) {
      const g = (k) => (ov[k] !== undefined ? ov[k] : r.params[k]?.default);
      const blinks = g('blinks');
      const cycle = g('cycle');
      const settle = g('settle');
      // the law is fixed-time and entry.window feeds exclusionAlpha directly —
      // a missing window is not just un-validated, it crashes the renderer
      if (!carrier.window) {
        err(`${where}: recipe "blink-then-stay" requires a "window"`);
      } else if (
        typeof blinks === 'number' && typeof cycle === 'number' && typeof settle === 'number'
      ) {
        const need = blinks * cycle + settle;
        const [a, b] = carrier.window.map(parseTimecode);
        if (a !== null && b !== null && (b - a) < need) {
          warn(
            `${where}: entry window ${(b - a).toFixed(2)}s shorter than blink law needs ${need.toFixed(2)}s (blinks×cycle+settle)`
          );
        }
      }
    }
  } else {
    // registry not landed (spec §12): warn-only
    if (carrier.recipe) warn(`${where}: recipe checks inactive (recipes.json absent) — "${carrier.recipe}" unchecked`);
    if (carrier.overrides) warn(`${where}: overrides present but recipes.json absent — keys unchecked`);
  }
}

// ------- timecode model -------
function parseTimecode(s) {
  // strict (HH:)MM:SS:FF at 24fps; returns seconds or null
  if (typeof s !== 'string') return null;
  const m = s.match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, hh, mm, ss, ff] = m;
  if (Number(mm) > 59 || Number(ss) > 59 || Number(ff) > 23) return null;
  return (((Number(hh || 0) * 60 + Number(mm)) * 60 + Number(ss)) + Number(ff) / 24);
}

let sceneLenSec = null; // set per scene in validateScene()
let sceneLen = null;
function noteTC(tc, where) {
  const t = parseTimecode(tc);
  if (t === null) err(`${where}: malformed timecode ${JSON.stringify(tc)} (must be strict (HH:)MM:SS:FF at 24fps)`);
  return t;
}

function checkWindowPair(w, where, { required = true } = {}) {
  if (w === undefined || w === null) {
    if (required) err(`${where}: missing "window"`);
    return null;
  }
  if (!Array.isArray(w) || w.length !== 2) {
    err(`${where}: "window" must be [start, end]`);
    return null;
  }
  const a = noteTC(w[0], `${where}.window[0]`);
  const b = noteTC(w[1], `${where}.window[1]`);
  if (a === null || b === null) return null;
  if (a >= b) err(`${where}: window start must be < end (${w[0]} !< ${w[1]})`);
  if (sceneLenSec !== null && (a < 0 || b > sceneLenSec)) {
    err(`${where}: window ${w[0]}–${w[1]} outside scene length ${sceneLen}`);
  }
  return [a, b];
}

// ------- geometry helpers -------
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

function walkCoords(coords, fn) {
  if (typeof coords[0] === 'number') fn(coords);
  else for (const c of coords) walkCoords(c, fn);
}

function checkGeomRounding(geom, where) {
  if (!geom || !geom.coordinates) return;
  walkCoords(geom.coordinates, (c) => {
    if (Array.isArray(c) && c.length >= 2 && (round6(c[0]) !== c[0] || round6(c[1]) !== c[1])) {
      warn(`${where}: coordinate ${JSON.stringify(c)} not rounded to 6 decimals (error once production renders start)`);
    }
  });
}

function validPolygonGeometry(g) {
  if (!g || !ALLOWED_EXCLUSION_SHAPES.includes(g.type)) return false;
  const rings = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of rings) {
    if (!Array.isArray(poly) || poly.length === 0) return false;
    for (const ring of poly) {
      if (!Array.isArray(ring)) return false;
      if (ring.length < 4) return false;
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return false;
    }
  }
  return true;
}

// ------- unknown-field check (deep) -------
function unknownFields(obj, allowed, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) warn(`${where}: unknown field "${k}"`);
  }
}

// ------- scene checks -------
function validateScene(file) {
  const scene = readJSON(file);
  if (scene === null) {
    err(`${path.basename(file)}: file does not parse as JSON`);
    return;
  }
  unknownFields(scene, TOP_LEVEL_KEYS, path.basename(file));

  // v1.18 — optional close-zoom street/path detail. Boolean only; layers ship
  // hidden and at minzoom 14, so absent/false leaves existing scenes untouched.
  if (scene.streets !== undefined && typeof scene.streets !== 'boolean') {
    err(`streets must be a boolean (true enables minor roads/service/paths at zoom >= 14)`);
  }

  // --- scene metadata ---
  unknownFields(scene.scene || {}, SCHEMA.scene, 'scene');
  const meta = scene.scene || {};
  if (typeof meta.video !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.video)) {
    err(`scene.video must be a non-empty lowercase slug`);
  }
  if (!Number.isInteger(meta.nn)) err(`scene.nn must be an integer`);
  if (typeof meta.title !== 'string' || !meta.title) err(`scene.title must be a non-empty string`);
  if (!meta.framing || !FRAMING_VALUES.includes(meta.framing)) {
    err(`scene.framing must be one of ${FRAMING_VALUES.join(', ')}`);
  }
  const sceneLen_ = meta.length;
  if (!sceneLen_) err(`scene.length missing`);
  sceneLenSec = parseTimecode(sceneLen_);
  sceneLen = sceneLen_;
  if (sceneLen_ && sceneLenSec === null) err(`scene.length "${JSON.stringify(sceneLen_)}" is not a strict (HH:)MM:SS:FF timecode`);

  // filename match
  const base = path.basename(file);
  const m = base.match(VIDEO_RE);
  if (!m) err(`filename "${base}" must match <video>[-intro]-<nn>-<slug>.json`);
  else {
    const [, fvideo, fnn] = m;
    if (meta.video && fvideo !== meta.video) err(`filename video "${fvideo}" ≠ scene.video "${meta.video}"`);
    if (Number.isInteger(meta.nn) && Number(fnn) !== meta.nn) {
      err(`filename nn "${fnn}" ≠ scene.nn ${meta.nn}`);
    }
  }

  // camera
  if (scene.camera !== undefined && scene.camera !== null) {
    unknownFields(scene.camera, SCHEMA.camera, 'camera');
    if (!Array.isArray(scene.camera.waypoints)) {
      err(`camera.waypoints must be an array (or camera must be omitted)`);
    } else {
      const wps = scene.camera.waypoints;
      if (wps.length === 0) warn(`camera.waypoints is empty — omit camera for a static shot`);
      let prev = null;
      wps.forEach((wp, i) => {
        unknownFields(wp, SCHEMA.waypoint, `camera.waypoints[${i}]`);
        if (!Array.isArray(wp.center) || wp.center.length !== 2 || typeof wp.center[0] !== 'number') {
          err(`camera.waypoints[${i}].center must be [lon, lat]`);
        } else {
          const [lon, lat] = wp.center;
          if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            err(`camera.waypoints[${i}].center out of WGS84 range`);
          } else if (round6(lon) !== lon || round6(lat) !== lat) {
            warn(`camera.waypoints[${i}].center not rounded to 6 decimals (error once production renders start)`);
          }
        }
        if (typeof wp.zoom !== 'number') err(`camera.waypoints[${i}].zoom must be a number`);
        if (wp.bearing !== undefined && typeof wp.bearing !== 'number') err(`camera.waypoints[${i}].bearing must be a number`);
        if (wp.pitch !== undefined && typeof wp.pitch !== 'number') err(`camera.waypoints[${i}].pitch must be a number`);
        const t = noteTC(wp.at, `camera.waypoints[${i}].at`);
        if (t !== null) {
          if (sceneLenSec !== null && t > sceneLenSec) {
            err(`camera.waypoints[${i}].at ${wp.at} beyond scene length`);
          }
          if (i === 0 && wp.at !== '00:00:00') err(`first camera waypoint must be at 00:00:00`);
          if (prev !== null && t <= prev) err(`camera.waypoints[${i}].at not strictly increasing after waypoint 0`);
          prev = t;
        }
      });
      if (scene.camera.overrides) checkOverrides(scene.camera, 'waypoint-glide', 'camera');
    }
  }

  // lines
  if (scene.lines !== undefined && scene.lines !== null) {
    if (!Array.isArray(scene.lines)) err(`lines must be an array of line slugs`);
    else {
      for (const slug of scene.lines) {
        if (typeof slug !== 'string') err(`lines: expected string slug, got ${JSON.stringify(slug)}`);
        else {
          const line = findLine(slug);
          if (!line) {
            if (geoPresent) err(`lines: line "${slug}" not found in data/geo/lines/`);
            else warn(`lines: cannot check line "${slug}" (geo db absent — geo-ghost)`);
          }
        }
      }
    }
  }

  // lineEntrances (v1.3, additive): full-line fade-in mid-clip
  if (scene.lineEntrances !== undefined && !Array.isArray(scene.lineEntrances)) {
    err(`lineEntrances must be an array`);
  }
  const staticLines = new Set((scene.lines || []).filter((s) => typeof s === 'string'));
  const entranceLines = new Set();
  for (const [i, le] of (scene.lineEntrances || []).entries()) {
    unknownFields(le, SCHEMA.lineEntrance, `lineEntrances[${i}]`);
    if (typeof le.line !== 'string') err(`lineEntrances[${i}].line must be a line slug string`);
    else {
      const line = findLine(le.line);
      if (!line) {
        if (geoPresent) err(`lineEntrances[${i}]: line "${le.line}" not found in data/geo/lines/`);
        else warn(`lineEntrances[${i}]: cannot check line "${le.line}" (geo db absent — geo-ghost)`);
      }
      if (staticLines.has(le.line)) {
        err(`lineEntrances[${i}]: line "${le.line}" is also in the static "lines" list (always-on wins — remove one)`);
      }
      if (entranceLines.has(le.line)) {
        err(`lineEntrances[${i}]: duplicate line "${le.line}" (at most one entrance per line)`);
      }
      entranceLines.add(le.line);
    }
    checkWindowPair(le.window, `lineEntrances[${i}]`);
    pushWindow(le.window, `lineEntrances[${i}]`);
    if (le.window || le.overrides) checkOverrides(le, 'line-fade', `lineEntrances[${i}]`);
  }

  // exclusions
  const exclIds = new Set();
  if (scene.exclusions !== undefined && !Array.isArray(scene.exclusions)) {
    err(`exclusions must be an array`);
  }
  for (const [i, ex] of (scene.exclusions || []).entries()) {
    unknownFields(ex, SCHEMA.exclusion, `exclusions[${i}]`);
    if (typeof ex.id !== 'string' || !ex.id) err(`exclusions[${i}].id must be a non-empty string`);
    else if (exclIds.has(ex.id)) err(`exclusions[${i}].id must be unique ("${ex.id}" reused)`);
    exclIds.add(ex.id);

    // shape: inline GeoJSON or shared shape slug
    if (typeof ex.shape === 'string') {
      const sp = path.join(ROOT, 'scenes/shapes', `${ex.shape}.geojson`);
      if (!fs.existsSync(sp)) err(`exclusions[${i}].shape "${ex.shape}" not found in scenes/shapes/`);
      else {
        const parsed = readJSON(sp);
        if (!parsed || !validPolygonGeometry(parsed)) {
          err(`exclusions[${i}].shape "${ex.shape}": scenes/shapes/${ex.shape}.geojson is not a valid Polygon/MultiPolygon`);
        }
      }
    } else if (!ex.shape || !ALLOWED_EXCLUSION_SHAPES.includes(ex.shape.type) || !validPolygonGeometry(ex.shape)) {
      err(`exclusions[${i}].shape must be inline GeoJSON Polygon/MultiPolygon or a shared shape slug`);
    } else {
      checkGeomRounding(ex.shape, `exclusions[${i}].shape`);
    }

    // entry
    unknownFields(ex.entry || {}, SCHEMA.entry, `exclusions[${i}].entry`);
    if (!ex.entry || typeof ex.entry.recipe !== 'string') {
      err(`exclusions[${i}].entry.recipe missing`);
    } else {
      const recipe = recipeFor(ex.entry.recipe);
      if (registryActive && !recipe) {
        // (message already emitted by checkOverrides below)
      } else if (registryActive && recipe) {
        const kindsOk = (recipe.kinds || []).includes('exclusions');
        if (!kindsOk) err(`exclusions[${i}].entry: recipe "${ex.entry.recipe}" does not back element kind "exclusions"`);
      }
      checkOverrides(ex.entry, ex.entry.recipe, `exclusions[${i}].entry`);
      pushWindow(ex.entry.window, `exclusions[${i}].entry`);
      if (ex.entry.recipe === 'present-from-start' && ex.entry.window) {
        warn(`exclusions[${i}].entry: recipe "present-from-start" takes no window (ignored)`);
      }
    }
  }

  // rides
  if (scene.rides !== undefined && !Array.isArray(scene.rides)) err(`rides must be an array`);
  for (const [i, r] of (scene.rides || []).entries()) {
    unknownFields(r, SCHEMA.ride, `rides[${i}]`);
    if (typeof r.line !== 'string') err(`rides[${i}].line must be a line slug string`);
    if (typeof r.from !== 'string') err(`rides[${i}].from must be a station slug`);
    if (typeof r.to !== 'string') err(`rides[${i}].to must be a station slug`);
    if (typeof r.line === 'string') {
      const line = findLine(r.line);
      if (line) {
        const st = (line.properties && line.properties.stations) || [];
        for (const k of ['from', 'to']) {
          if (typeof r[k] === 'string' && !st.includes(r[k])) {
            if (geoPresent) err(`rides[${i}].${k} "${r[k]}" is not a station of line "${r.line}"`);
            else warn(`rides[${i}].${k} "${r[k]}" unchecked (geo db absent — geo-ghost)`);
          }
        }
      } else if (geoPresent) {
        err(`rides[${i}]: line "${r.line}" not found in data/geo/lines/`);
      } else {
        warn(`rides[${i}]: line "${r.line}" unchecked (geo db absent — geo-ghost)`);
      }
    }
    checkWindowPair(r.window, `rides[${i}]`);
    pushWindow(r.window, `rides[${i}]`);
    if (r.window || r.overrides) checkOverrides(r, 'ride-highlight', `rides[${i}]`);
  }

  // pins
  for (const kind of ['seekers', 'hider']) {
    const pin = scene[kind];
    if (pin === undefined) continue;
    if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) {
      err(`${kind} must be an object (or omitted)`);
      continue;
    }
    unknownFields(pin, SCHEMA[kind], kind);
    if (typeof pin.photo !== 'string' || !pin.photo) err(`${kind}.photo must be a repo-root-relative path string`);
    else {
      const ap = path.join(ROOT, pin.photo);
      if (!fs.existsSync(ap)) {
        warn(`${kind}.photo "${pin.photo}" not found on disk (warn-checked while assets are pending)`);
      }
    }
    // start: station slug OR free coord (hand-authoring exception, v1.2) —
    // a pin may sit on a non-station location; the two are mutually exclusive
    if (pin.start && pin.start.coord !== undefined) {
      const c = pin.start.coord;
      if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') {
        err(`${kind}.start.coord must be [lon, lat]`);
      } else {
        const [lon, lat] = c;
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`${kind}.start.coord out of WGS84 range`);
        else if (round6(lon) !== lon || round6(lat) !== lat) {
          warn(`${kind}.start.coord not rounded to 6 decimals (error once production renders start)`);
        }
      }
      if (pin.start.station !== undefined) err(`${kind}.start: "station" and "coord" are mutually exclusive`);
    } else if (!pin.start || typeof pin.start.station !== 'string') {
      err(`${kind}.start.station must be a station slug`);
    } else if (geoPresent) {
      if (!stations.has(pin.start.station)) err(`${kind}.start.station "${pin.start.station}" not in stations.geojson`);
    } else {
      warn(`${kind}.start.station "${pin.start.station}" unchecked (geo db absent — geo-ghost)`);
    }
    // v1.16 pin tilt: scene-authored rotation about the spike tip (degrees,
    // clockwise-positive like CSS; 0/absent = the frozen upright look)
    if (pin.tilt !== undefined) {
      if (typeof pin.tilt !== 'number' || !Number.isFinite(pin.tilt)) {
        err(`${kind}.tilt must be a number (degrees)`);
      } else if (pin.tilt < -60 || pin.tilt > 60) {
        err(`${kind}.tilt must be between -60 and 60 degrees`);
      }
    }
    if (pin.window !== undefined) { checkWindowPair(pin.window, kind); pushWindow(pin.window, kind); }
    if (pin.window || pin.overrides) checkOverrides(pin, 'pin-fade', kind);
    if (!Array.isArray(pin.moves)) err(`${kind}.moves must be an array`);
    let prevTo = null;
    let prevToCoord = null; // v1.7: chaining also works across coord moves
    (pin.moves || []).forEach((mv, i) => {
      unknownFields(mv, SCHEMA.move, `${kind}.moves[${i}]`);
      const hasFC = mv['from-coord'] !== undefined;
      const hasTC = mv['to-coord'] !== undefined;
      // v1.7 coord moves: from/to may carry coordinates (hand-authoring
      // exception, same class as pin.start.coord) — but never both forms
      if (hasFC || hasTC) {
        for (const [k, v] of [['from-coord', mv['from-coord']], ['to-coord', mv['to-coord']]]) {
          if (v === undefined) continue;
          if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number') {
            err(`${kind}.moves[${i}].${k} must be [lon, lat]`);
          } else {
            const [lon, lat] = v;
            if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`${kind}.moves[${i}].${k} out of WGS84 range`);
            else if (round6(lon) !== lon || round6(lat) !== lat) {
              warn(`${kind}.moves[${i}].${k} not rounded to 6 decimals (error once production renders start)`);
            }
          }
        }
        if (mv.from !== undefined && hasFC) {
          err(`${kind}.moves[${i}]: "from" and "from-coord" are mutually exclusive`);
        }
        if (mv.to !== undefined && hasTC) {
          err(`${kind}.moves[${i}]: "to" and "to-coord" are mutually exclusive`);
        }
        if (!hasFC && typeof mv.from !== 'string') err(`${kind}.moves[${i}].from must be a station slug (or use from-coord)`);
        if (!hasTC && typeof mv.to !== 'string') err(`${kind}.moves[${i}].to must be a station slug (or use to-coord)`);
        if (hasFC && hasTC && mv.line !== undefined) {
          warn(`${kind}.moves[${i}].line is ignored on pure coord moves (both endpoints are coordinates)`);
        }
        // v1.7 chaining: previous move's endpoint (station slug or coord)
        // must equal this move's startpoint (same form, or both resolve in
        // the geo db to the same place)
        if (prevTo !== null || prevToCoord !== null) {
          const fc = hasFC ? mv['from-coord'] : (mv.from !== undefined ? mv.from : null);
          const fcIsCoord = hasFC;
          const prevIsCoord = prevToCoord !== null;
          if (prevIsCoord !== fcIsCoord) {
            err(`${kind}.moves[${i}]: from ${fcIsCoord ? 'coord' : 'slug'} "${JSON.stringify(fc)}" does not chain from previous move's ${prevIsCoord ? 'coord' : 'slug'} (${prevIsCoord ? JSON.stringify(prevToCoord) : prevTo})`);
          } else if (prevIsCoord) {
            if (fc[0] !== prevToCoord[0] || fc[1] !== prevToCoord[1]) {
              err(`${kind}.moves[${i}]: from-coord ${JSON.stringify(fc)} does not chain from previous move's to-coord ${JSON.stringify(prevToCoord)}`);
            }
          } else if (fc !== prevTo) {
            err(`${kind}.moves[${i}].from "${fc}" does not chain from previous move to "${prevTo}"`);
          }
        }
        prevTo = hasTC ? undefined : mv.to;
        prevToCoord = hasTC ? mv['to-coord'] : null;
      } else {
        if (typeof mv.from !== 'string') err(`${kind}.moves[${i}].from must be a station slug`);
        if (typeof mv.to !== 'string') err(`${kind}.moves[${i}].to must be a station slug`);
        if (prevTo !== null && mv.from !== prevTo) {
          err(`${kind}.moves[${i}].from "${mv.from}" does not chain from previous move to "${prevTo}"`);
        } else if (prevToCoord !== null) {
          // previous was a coord move — this station move cannot chain from a coordinate
          err(`${kind}.moves[${i}].from "${mv.from}" does not chain from previous move's to-coord ${JSON.stringify(prevToCoord)}`);
        }
        prevTo = mv.to;
        prevToCoord = null;
      }
      checkWindowPair(mv.window, `${kind}.moves[${i}]`);
      pushWindow(mv.window, `${kind}.moves[${i}]`);
    });
  }

  // labels
  if (scene.labels !== undefined && !Array.isArray(scene.labels)) err(`labels must be an array`);
  for (const [i, lb] of (scene.labels || []).entries()) {
    unknownFields(lb, SCHEMA.label, `labels[${i}]`);
    if (typeof lb.station !== 'string') err(`labels[${i}].station must be a station slug`);
    else if (geoPresent && !stations.has(lb.station)) {
      err(`labels[${i}].station "${lb.station}" not in stations.geojson`);
    }
    if (lb.line !== undefined) {
      if (typeof lb.line !== 'string') err(`labels[${i}].line must be a line slug string`);
      else {
        const line = findLine(lb.line);
        if (!line) {
          if (geoPresent) err(`labels[${i}].line "${lb.line}" not found in data/geo/lines/`);
          else warn(`labels[${i}].line "${lb.line}" unchecked (geo db absent — geo-ghost)`);
        } else {
          const st = (line.properties && line.properties.stations) || [];
          if (typeof lb.station === 'string' && !st.includes(lb.station)) {
            warn(`labels[${i}]: station "${lb.station}" is not listed on line "${lb.line}"`);
          }
        }
      }
    }
    checkWindowPair(lb.window, `labels[${i}]`);
    pushWindow(lb.window, `labels[${i}]`);
    // v1.10 dot-pulse — mutually exclusive with grow (one dot-size motion)
    const hasGrow = lb.grow !== undefined || lb['grow-at'] !== undefined;
    const hasPulse = lb.pulse !== undefined || lb['pulse-at'] !== undefined;
    // label-fade checks the fade keys only — grow-in/pulse-* belong to the
    // dot-grow/dot-pulse recipes (checked below when their scene fields are
    // present); leaving them in would falsely error as unknown label-fade
    // keys and make the dot-law override path unreachable
    const fadeOv = { overrides: {} };
    if (lb.overrides) {
      for (const k of ['grow-in', 'pulse-in', 'pulse-hold', 'pulse-out']) {
        if (lb.overrides[k] !== undefined) fadeOv.overrides[k] = lb.overrides[k];
      }
    }
    const stripped = lb.overrides ? { ...lb, overrides: Object.fromEntries(
      Object.entries(lb.overrides).filter(([k]) => !fadeOv.overrides[k])
    ) } : lb;
    if (lb.window || lb.overrides) checkOverrides(stripped, 'label-fade', `labels[${i}]`);
    if (lb.overrides && (hasGrow || lb.overrides['grow-in'] !== undefined)) {
      // grow uses the dot-grow recipe; validate only dot-grow-relevant keys
      // (fade-in/fade-out belong to label-fade, checked above)
      const growOv = {};
      if (lb.overrides['grow-in'] !== undefined) growOv['grow-in'] = lb.overrides['grow-in'];
      checkOverrides({ overrides: growOv }, 'dot-grow', `labels[${i}]`);
      // grow-in without a grow scene field is inert — the never-applied
      // override would silently render with the recipe default
      if (!hasGrow) {
        err(`labels[${i}]: overrides["grow-in"] without "grow"/"grow-at" (no dot-grow would be applied)`);
      }
    }
    if (lb.overrides && (hasPulse || lb.overrides['pulse-in'] !== undefined || lb.overrides['pulse-hold'] !== undefined || lb.overrides['pulse-out'] !== undefined)) {
      // pulse uses the dot-pulse recipe; validate only pulse-relevant keys
      const pulseOv = {};
      if (lb.overrides['pulse-in'] !== undefined) pulseOv['pulse-in'] = lb.overrides['pulse-in'];
      if (lb.overrides['pulse-hold'] !== undefined) pulseOv['pulse-hold'] = lb.overrides['pulse-hold'];
      if (lb.overrides['pulse-out'] !== undefined) pulseOv['pulse-out'] = lb.overrides['pulse-out'];
      checkOverrides({ overrides: pulseOv }, 'dot-pulse', `labels[${i}]`);
      if (!hasPulse) {
        err(`labels[${i}]: overrides["pulse-*"] without "pulse"/"pulse-at" (no dot-pulse would be applied)`);
      }
    }
    if (lb.grow !== undefined) {
      if (typeof lb.grow !== 'number' || lb.grow < 1) err(`labels[${i}].grow must be a number ≥ 1`);
      if (lb['grow-at'] === undefined) err(`labels[${i}].grow requires "grow-at"`);
      else if (parseTimecode(lb['grow-at']) === null) err(`labels[${i}].grow-at is not a strict (HH:)MM:SS:FF timecode`);
      else if (sceneLenSec !== null && parseTimecode(lb['grow-at']) > sceneLenSec) {
        err(`labels[${i}].grow-at beyond scene length`);
      }
    } else if (lb['grow-at'] !== undefined) {
      err(`labels[${i}].grow-at without "grow" (set the target scale)`);
    }
    // v1.10 dot-pulse — mutually exclusive with grow (one dot-size motion)
    // (hasGrow/hasPulse hoisted above the label-fade override routing)
    if (hasPulse && hasGrow) {
      err(`labels[${i}]: "pulse"/"pulse-at" and "grow"/"grow-at" are mutually exclusive (one dot-size motion per label)`);
    }
    if (hasPulse) {
      if (lb.pulse !== undefined && (typeof lb.pulse !== 'number' || lb.pulse < 1)) err(`labels[${i}].pulse must be a number ≥ 1`);
      if (lb['pulse-at'] === undefined) err(`labels[${i}].pulse requires "pulse-at"`);
      else if (parseTimecode(lb['pulse-at']) === null) err(`labels[${i}].pulse-at is not a strict (HH:)MM:SS:FF timecode`);
      else if (sceneLenSec !== null && parseTimecode(lb['pulse-at']) > sceneLenSec) {
        err(`labels[${i}].pulse-at beyond scene length`);
      }
    } else if (lb['pulse-at'] !== undefined) {
      err(`labels[${i}].pulse-at without "pulse" (set the target scale)`);
    }
    if (lb['label-side'] !== undefined && lb['label-side'] !== 'left') {
      err(`labels[${i}].label-side must be "left" (default is right)`);
    }
    // v1.11 dot-scale — base-size multiplier for the dot (pulse/grow compose
    // on top). Number, 0.05–3; 1 = frozen round-5 size.
    if (lb['dot-scale'] !== undefined &&
        (typeof lb['dot-scale'] !== 'number' || lb['dot-scale'] < 0.05 || lb['dot-scale'] > 3)) {
      err(`labels[${i}].dot-scale must be a number in [0.05, 3] (dot base-size multiplier; 1 = frozen size)`);
    }
    if (lb['label-dy'] !== undefined && (typeof lb['label-dy'] !== 'number' || lb['label-dy'] < -100 || lb['label-dy'] > 100)) {
      err(`labels[${i}].label-dy must be a number in [-100, 100] (px, negative = up)`);
    }
    // v1.14 label-scale — text-size multiplier (never the dot). Number,
    // 0.5–3; 1 = the frozen 27px station-name token.
    if (lb['label-scale'] !== undefined &&
        (typeof lb['label-scale'] !== 'number' || lb['label-scale'] < 0.5 || lb['label-scale'] > 3)) {
      err(`labels[${i}].label-scale must be a number in [0.5, 3] (text-size multiplier; 1 = frozen size)`);
    }
  }

  // points (free points, hand-authored coordinates — camera-center exception)
  if (scene.points !== undefined && !Array.isArray(scene.points)) err(`points must be an array`);
  for (const [i, pt] of (scene.points || []).entries()) {
    unknownFields(pt, SCHEMA.point, `points[${i}]`);
    if (!Array.isArray(pt.coord) || pt.coord.length !== 2 || typeof pt.coord[0] !== 'number' || typeof pt.coord[1] !== 'number') {
      err(`points[${i}].coord must be [lon, lat]`);
    } else {
      const [lon, lat] = pt.coord;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`points[${i}].coord out of WGS84 range`);
      else if (round6(lon) !== lon || round6(lat) !== lat) {
        warn(`points[${i}].coord not rounded to 6 decimals (error once production renders start)`);
      }
    }
    if (typeof pt.text !== 'string' || !pt.text) err(`points[${i}].text must be a non-empty string`);
    // v1.8: optional scene-authored hex color (free-point vocabulary: black is
    // the default; per-point color is the leander-22 hospital dots case)
    if (pt.color !== undefined && (typeof pt.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(pt.color))) {
      err(`points[${i}].color must be a "#RRGGBB" hex string`);
    }
    // v1.9: optional base-size multiplier (dot + text), static via CSS var.
    // v1.17: range widened below 1 so a scene can shrink a free-point label
    // under the frozen station-name size (oskar-24 Golf Resort).
    if (pt.scale !== undefined &&
        (typeof pt.scale !== 'number' || pt.scale < 0.3 || pt.scale > 3)) {
      err(`points[${i}].scale must be a number in [0.3, 3]`);
    }
    // v1.12: label-dy (px vertical offset, negative = up) — the labels v1.6
    // vocabulary completed for points
    if (pt['label-dy'] !== undefined && (typeof pt['label-dy'] !== 'number' || pt['label-dy'] < -100 || pt['label-dy'] > 100)) {
      err(`points[${i}].label-dy must be a number in [-100, 100] (px, negative = up)`);
    }
    checkWindowPair(pt.window, `points[${i}]`);
    pushWindow(pt.window, `points[${i}]`);
    if (pt.window || pt.overrides) checkOverrides(pt, 'point-fade', `points[${i}]`);
  }

  // segments (straight screen-space lines between hand-authored coordinates)
  if (scene.segments !== undefined && !Array.isArray(scene.segments)) err(`segments must be an array`);
  for (const [i, sg] of (scene.segments || []).entries()) {
    unknownFields(sg, SCHEMA.segment, `segments[${i}]`);
    if (!Array.isArray(sg.coords) || sg.coords.length !== 2 ||
        !sg.coords.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number')) {
      err(`segments[${i}].coords must be [[lon, lat], [lon, lat]]`);
    } else {
      for (const [j, c] of sg.coords.entries()) {
        const [lon, lat] = c;
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`segments[${i}].coords[${j}] out of WGS84 range`);
        else if (round6(lon) !== lon || round6(lat) !== lat) {
          warn(`segments[${i}].coords[${j}] not rounded to 6 decimals (error once production renders start)`);
        }
      }
    }
    checkWindowPair(sg.window, `segments[${i}]`);
    pushWindow(sg.window, `segments[${i}]`);
    if (sg.window || sg.overrides) checkOverrides(sg, 'segment-draw', `segments[${i}]`);
  }

  // paths (v1.12, additive): hand-authored route polylines (walking routes)
  if (scene.paths !== undefined && !Array.isArray(scene.paths)) err(`paths must be an array`);
  for (const [i, pa] of (scene.paths || []).entries()) {
    unknownFields(pa, SCHEMA.path, `paths[${i}]`);
    if (!Array.isArray(pa.coords) || pa.coords.length < 2 ||
        !pa.coords.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'number' && typeof c[1] === 'number')) {
      err(`paths[${i}].coords must be [[lon, lat], …] (at least two points)`);
    } else {
      for (const [j, c] of pa.coords.entries()) {
        const [lon, lat] = c;
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`paths[${i}].coords[${j}] out of WGS84 range`);
        else if (round6(lon) !== lon || round6(lat) !== lat) {
          warn(`paths[${i}].coords[${j}] not rounded to 6 decimals (error once production renders start)`);
        }
      }
    }
    // v1.12: optional scene-authored hex color (default is the frozen grey
    // walking-route token; scene color is the points[].color exception class)
    if (pa.color !== undefined && (typeof pa.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(pa.color))) {
      err(`paths[${i}].color must be a "#RRGGBB" hex string`);
    }
    checkWindowPair(pa.window, `paths[${i}]`);
    pushWindow(pa.window, `paths[${i}]`);
    if (pa.window || pa.overrides) checkOverrides(pa, 'path-highlight', `paths[${i}]`);
    // v1.21 walking-trace append: prefix already walked (arc-length fraction)
    // stays drawn; the suffix grows over the append window — one path object,
    // continuous dash phase across the junction.
    if (pa.append !== undefined) {
      if (!pa.append || typeof pa.append !== 'object' || Array.isArray(pa.append)) {
        err(`paths[${i}].append must be an object { from, window }`);
      } else {
        const { from, window: aw } = pa.append;
        if (typeof from !== 'number' || from < 0 || from >= 1) {
          err(`paths[${i}].append.from must be a number in [0, 1)`);
        }
        if (pa.append.easing !== undefined &&
            !['smoothstep', 'linear', 'ease-in', 'ease-out'].includes(pa.append.easing)) {
          err(`paths[${i}].append.easing must be one of smoothstep | linear | ease-in | ease-out`);
        }
        checkWindowPair(aw, `paths[${i}].append`);
      }
    }
  }

  // circles (v1.5, additive): hand-authored center + great-circle radius
  if (scene.circles !== undefined && !Array.isArray(scene.circles)) err(`circles must be an array`);
  for (const [i, ci] of (scene.circles || []).entries()) {
    unknownFields(ci, SCHEMA.circle, `circles[${i}]`);
    if (!Array.isArray(ci.center) || ci.center.length !== 2 || typeof ci.center[0] !== 'number' || typeof ci.center[1] !== 'number') {
      err(`circles[${i}].center must be [lon, lat]`);
    } else {
      const [lon, lat] = ci.center;
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) err(`circles[${i}].center out of WGS84 range`);
      else if (round6(lon) !== lon || round6(lat) !== lat) {
        warn(`circles[${i}].center not rounded to 6 decimals (error once production renders start)`);
      }
    }
    if (typeof ci['radius-m'] !== 'number' || !(ci['radius-m'] > 0)) {
      err(`circles[${i}].radius-m must be a positive number (meters)`);
    }
    checkWindowPair(ci.window, `circles[${i}]`);
    pushWindow(ci.window, `circles[${i}]`);
    if (ci.window || ci.overrides) checkOverrides(ci, 'circle-draw', `circles[${i}]`);
  }

  // window overlaps between elements (warn; grouped by element-kind pair).
  // Identical window pairs (string-level) are group reveals by design —
  // e.g. the all-stations dot wall — never a timing bug worth a warning.
  const ranges = [];
  for (const w of overlapWindows) {
    if (!w.range) continue;
    const a = parseTimecode(w.range[0]);
    const b = parseTimecode(w.range[1]);
    if (a === null || b === null) continue;
    ranges.push({ a, b, where: w.where, kind: w.kind, range: w.range });
  }
  overlapRuns = new Map();
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const A = ranges[i];
      const B = ranges[j];
      if (A.where === B.where) continue;
      if (A.range[0] === B.range[0] && A.range[1] === B.range[1]) continue;
      if (A.a < B.b && B.a < A.b) {
        const key = `${A.kind}|${B.kind}`;
        overlapRuns.set(key, (overlapRuns.get(key) || 0) + 1);
      }
    }
  }
  if (overlapRuns.size) {
    const parts = [...overlapRuns].map(([key, n]) => `${key.replace('|', '/')}${n > 1 ? `×${n}` : ''}`);
    warn(`co-window overlaps (authoring nudge, not an error): ${parts.join(', ')}`);
  }
  overlapRuns = new Map();
  overlapWindows = [];
}

// windows registered per scene for the grouped overlap check (reset per scene)
let overlapWindows = [];
let overlapRuns = new Map(); // kind-pair → repeats, filled per scene, flushed per scene
function pushWindow(range, where) {
  if (!range) return;
  overlapWindows.push({ range, where, kind: where.split(/[.[]/)[0] });
}


for (const f of targets) validateScene(f);

console.log(`\nvalidate-scene: ${targets.length} file(s)`);
for (const e of errors) console.error(`  ERROR ${e}`);
for (const w of warns) console.warn(`  warn  ${w}`);
console.log(`  ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
