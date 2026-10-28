// interpreter.js — browser-side scene interpretation (§7.4-7.5).
// Historical comments reference scene names from the production project this
// kit was extracted from. They document why a law exists; they are not data.
// Pure functions + a frame driver that maps scene JSON + resolved geo data to
// per-frame MapLibre/2D-canvas state. Loaded via <script> by page/index.html.
// Deterministic from t = frame / 24 only. No MapLibre animation APIs.

'use strict';

// ---------------- choreography helpers (validated prototype laws) ----------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (x) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
const linear = (x) => clamp01(x);
// verdict round 22 (ticket 06): one-sided easings — ease only the start
// (accelerate from rest) or only the end (decelerate to rest); smoothstep
// stays the both-ends default.
const easeIn = (x) => { const c = clamp01(x); return c * c; };
const easeOut = (x) => { const c = clamp01(x); return 1 - (1 - c) * (1 - c); };
const EASINGS = { smoothstep, linear, 'ease-in': easeIn, 'ease-out': easeOut };
const lerp = (a, b, t) => a + (b - a) * t;
// [a, b] seconds → 0..1 progress within the segment
const SEG = ([a, b], s) => clamp01((s - a) / (b - a));

// ---------------- recipe defaults (recipes/recipes.json, injected) ----------------
// window.__RECIPES = the registry JSON (injected by the server via /recipes.json)
function recipeParams(name) {
  const r = (window.__RECIPES || {})[name];
  if (!r) throw new Error(`recipe "${name}" not in registry`);
  const out = {};
  for (const [k, p] of Object.entries(r.params || {})) out[k] = p.default;
  return out;
}

function paramSet(recipeName, overrides) {
  const base = recipeParams(recipeName);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!(k in base)) throw new Error(`unknown override "${k}" for recipe "${recipeName}"`);
    base[k] = v;
  }
  return base;
}

function easingFn(name) {
  const f = EASINGS[name];
  if (!f) throw new Error(`unknown easing "${name}" (library: smoothstep | linear)`);
  return f;
}

// ---------------- time model ----------------
// timecodes arrive pre-parsed by the node driver as seconds (float, frame-exact)

// exclusion entry: present-from-start | blink-then-stay (fixed-time law).
// Ben's verdict rounds (ticket 06): the rhythm OPENS ON THE LIGHT BEAT
// (round 4 — the area appears near-transparent first, then flashes), the
// light beats sit at blink-alpha (round 4: 0.15 → 0.08), on-beats ramp
// dim→brighter across the sequence, and the settle continues from the last
// on-beat's alpha up to full (never dropping back to blink-alpha).
function exclusionAlpha(entry, s) {
  if (!entry || entry.recipe === 'present-from-start') return 1.0;
  if (entry.recipe !== 'blink-then-stay') throw new Error(`unknown entry recipe "${entry.recipe}"`);
  const p = paramSet('blink-then-stay', entry.overrides);
  const [a, b] = entry.window; // seconds
  if (s < a) return 0;
  if (s >= b) return 1.0;
  const blinks = p.blinks;
  const cycle = p.cycle;
  const blinkSpan = blinks * cycle;
  const local = s - a;
  // starting light, the on-beats are the odd cycles
  const numOn = Math.floor(blinks / 2);
  const onAlpha = (onIdx) => lerp(0.6, 1.0, numOn > 1 ? onIdx / numOn : 0);
  if (local < blinkSpan) {
    const idx = Math.floor(local / cycle);
    if (idx % 2 === 0) return p['blink-alpha']; // light beat first
    return onAlpha((idx - 1) / 2);
  }
  const settle = smoothstep((local - blinkSpan) / p.settle);
  return lerp(onAlpha(numOn - 1), 1.0, settle); // settle from last on-beat
}

// ride highlight: window fade with clamped fades, smoothstep edges (static within).
// Window start is inclusive: with fade-in 0 the highlight is fully on from the
// first frame of the window (verdict round 21, ticket 06: frame-0 gap bug —
// the old `s <= a` edge plus 0/0 NaN at zero fade blanked the first frame).
function rideAlpha(ride, s) {
  const p = paramSet('ride-highlight', ride.overrides);
  const [a, b] = ride.window;
  const dur = b - a;
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return 0;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return Math.min(inA, outA);
}

// label fade: same clamped fade law (same round-21 frame-0 fix), defaults
// from label-fade
function labelAlpha(label, s) {
  const p = paramSet('label-fade', label.overrides);
  const [a, b] = label.window;
  const dur = b - a;
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return 0;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return Math.min(inA, outA);
}

// label dot grow (v1.4, additive): the dot scales 1 → label.grow starting at
// label['grow-at'] (seconds) over dot-grow's grow-in seconds, smoothstep,
// stays grown. Grow is a scene-authored amplitude (like from-progress); the
// law (duration default, easing) lives in the recipe. The dot-recipe override
// keys are routed here per key (labels mix fade-in/out for label-fade in the
// same overrides object — unknown keys would throw in paramSet).
function labelGrow(label, s) {
  if (!label.grow || label.grow === 1 || label['grow-at'] === undefined) return 1;
  const ov = label.overrides || {};
  const p = paramSet('dot-grow', ov['grow-in'] !== undefined ? { 'grow-in': ov['grow-in'] } : {});
  const k = clamp01((s - label['grow-at']) / p['grow-in']);
  return 1 + (label.grow - 1) * smoothstep(k);
}

// label dot pulse (v1.10, additive): the dot scales 1 → label.pulse → 1,
// starting at label['pulse-at'] (seconds): pulse-in up (smoothstep),
// pulse-hold at the top, pulse-out back down (smoothstep). Ends at exactly 1
// — unlike dot-grow it recovers. Amplitude is scene-authored (label.pulse);
// the timing law lives in the dot-pulse recipe. Per-key override routing,
// same as labelGrow (labels mix label-fade keys in the same overrides object).
function labelPulse(label, s) {
  if (!label.pulse || label.pulse === 1 || label['pulse-at'] === undefined) return 1;
  const ov = label.overrides || {};
  const keys = ['pulse-in', 'pulse-hold', 'pulse-out'];
  const routed = {};
  for (const k of keys) if (ov[k] !== undefined) routed[k] = ov[k];
  const p = paramSet('dot-pulse', routed);
  const t0 = label['pulse-at'];
  const up = clamp01((s - t0) / p['pulse-in']);
  if (up < 1) return 1 + (label.pulse - 1) * smoothstep(up);
  const hold = clamp01((s - t0 - p['pulse-in']) / p['pulse-hold']);
  if (hold < 1) return label.pulse;
  const down = clamp01((s - t0 - p['pulse-in'] - p['pulse-hold']) / p['pulse-out']);
  return 1 + (label.pulse - 1) * (1 - smoothstep(down));
}

// line entrance fade (v1.3, additive): same clamped fade law as labels,
// defaults from line-fade — the full Line geometry fades in mid-clip
function lineEntranceAlpha(le, s) {
  const p = paramSet('line-fade', le.overrides);
  const [a, b] = le.window;
  const dur = b - a;
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return 0;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return Math.min(inA, outA);
}

// free-point fade: same clamped fade law as labels, defaults from point-fade
function pointAlpha(point, s) {
  const p = paramSet('point-fade', point.overrides);
  const [a, b] = point.window;
  const dur = b - a;
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return 0;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return Math.min(inA, outA);
}

// pin-level fade (v1.2): same clamped fade law, defaults from pin-fade —
// pins carry an optional scene-level window ("pin appears at 8 s")
function pinAlpha(pin, s) {
  const p = paramSet('pin-fade', pin.overrides);
  const [a, b] = pin.window;
  const dur = b - a;
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return 0;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return Math.min(inA, outA);
}

// segment draw-on: tip grows from coords[0] toward coords[1] over draw-in at
// the window start, retracts from the start over draw-out at the window end
// (tip chases the far end); fade smooths both edges. Progress is eased
// smoothstep; alpha is the clamped fade law.
function segmentState(segment, s) {
  const p = paramSet('segment-draw', segment.overrides);
  const [a, b] = segment.window;
  const dur = b - a;
  const di = Math.min(p['draw-in'], dur / 2);
  const do_ = Math.min(p['draw-out'], dur / 2);
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return { alpha: 0, progress: 0 };
  const progress =
    s < a + di ? smoothstep((s - a) / di)
    : s > b - do_ ? 1 - smoothstep((s - (b - do_)) / do_)
    : 1;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return { alpha: Math.min(inA, outA), progress };
}

// circle draw-on (v1.5, additive): the rim tip grows clockwise from north
// over draw-in at the window start and retracts backward over draw-out at the
// window end (same law as segment-draw, wrapped on a ring); fade smooths both
// edges. progress ∈ [0, 1] = fraction of the full rim; alpha = clamped fade.
// Color: the exclusion violet (frozen token) — context circle reads as "not
// yet excluded" before handing over to the striped disc (leander-15).
const CIRCLE_COLOR = '#623CEA';
function circleState(circle, s) {
  const p = paramSet('circle-draw', circle.overrides);
  const [a, b] = circle.window;
  const dur = b - a;
  const di = Math.min(p['draw-in'], dur / 2);
  const do_ = Math.min(p['draw-out'], dur / 2);
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return { alpha: 0, progress: 0 };
  const progress =
    s < a + di ? smoothstep((s - a) / di)
    : s > b - do_ ? 1 - smoothstep((s - (b - do_)) / do_)
    : 1;
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return { alpha: Math.min(inA, outA), progress };
}

// pin position across chained moves: sits at start (or last to) outside windows
// pin.stations: slug → coord (resolved), pin.startStation: slug
// Move-level from-progress/to-progress (verdict round 21, ticket 06): 0–1
// along the from→to line geometry (resolved by page.js into
// mv.__fromCoord/mv.__toCoord) — lets a move start/end *between* stations
// ("just out of Ostkreuz", "almost at Ostbahnhof") without putting
// coordinates in scene JSON. Absent = exact station endpoints (unchanged).
// v1.7 coord moves (from-coord/to-coord): page.js resolves them into the
// same __fromCoord/__toCoord slots (plus private station-map entries), so a
// move glides between hand-authored points — straight chord between coords,
// no line geometry involved (mv.__seg stays absent, chord law applies).
function pinPosition(pin, s) {
  const coords = pin.stations || {};
  if (!pin.moves || pin.moves.length === 0) {
    return { coord: coords[pin.startStation] || null };
  }
  // which move (if any) is active at s. A move with from/to-station slugs
  // outside any window still needs pin.stations; progress-resolved endpoints
  // (mv.__fromCoord/__toCoord) take precedence when present.
  for (const mv of pin.moves) {
    const [a, b] = mv.window;
    if (s >= a && s < b) {
      // per-move override wins (validated against pin-glide's easing enum);
      // mv.easing is populated by page.js from mv.overrides.easing —
      // verdict round 21: the override existed in the format but was never
      // wired (silent fallback to smoothstep)
      const ease = mv.easing || mv.overrides?.easing || (pin.easingName || 'smoothstep');
      const f = easingFn(ease)(SEG(mv.window, s));
      // verdict round 22 (leander-06): progress moves slide ALONG the line's
      // from→to geometry (arc-length per the spec) instead of lerping the
      // straight chord between the two resolved endpoints — the chord visibly
      // cut the curved S1 between Brandenburger Tor and Potsdamer Platz.
      // Eased parameter runs over from→to-progress so easing still applies.
      if (mv.__seg && (mv.overrides?.['from-progress'] !== undefined ||
        mv.overrides?.['to-progress'] !== undefined)) {
        const fp = mv.overrides?.['from-progress'] ?? 0;
        const tp = mv.overrides?.['to-progress'] ?? 1;
        return { coord: pointAtProgress(mv.__seg, lerp(fp, tp, f)) };
      }
      const from = mv.__fromCoord || coords[mv.from];
      const to = mv.__toCoord || coords[mv.to];
      if (!from || !to) continue;
      return { coord: [lerp(from[0], to[0], f), lerp(from[1], to[1], f)] };
    }
  }
  // outside any window: last move whose window ended before s, else start.
  // A progress move (from/to-progress) resolves to an endpoint BETWEEN
  // stations — the pin rests at that resolved coordinate (mv.__toCoord),
  // never at the to-station (leander-14: pin gliding 0.2→0.4 must rest at 0.4)
  let resolved = null;
  for (const mv of pin.moves) {
    if (s >= mv.window[1]) resolved = mv;
  }
  if (resolved) {
    if (resolved.__toCoord) return { coord: resolved.__toCoord };
    return { coord: coords[resolved.__toSlug || resolved.to] || coords[resolved.to] || null };
  }
  return { coord: coords[pin.startStation] || null };
}

// camera along eased waypoints (eased per segment, recipe default: waypoint-glide).
// the recipe's easing default arrives as camera.easingName (set by page.js).
// v1.15: continuous path through >2 waypoints (camera.overrides.path = "spline").
// C1 cubic Hermite in the time domain: interior tangents are the centered
// finite difference over both neighbours, so the camera passes an intermediate
// waypoint at speed (no smoothstep rest stop); only the first and last
// waypoints have zero tangents, keeping the clip's ease-in/ease-out. With two
// waypoints both tangents are zero → identical to smoothstep.
function cameraAtSpline(camera, s) {
  const wps = camera.waypoints;
  const n = wps.length;
  for (let i = 0; i < n - 1; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    if (s > b.at) continue;
    const h = b.at - a.at;
    const f = clamp01((s - a.at) / h);
    const h00 = 2 * f * f * f - 3 * f * f + 1;
    const h10 = f * f * f - 2 * f * f + f;
    const h01 = -2 * f * f * f + 3 * f * f;
    const h11 = f * f * f - f * f;
    const tangent = (k, field, axis) => {
      if (k === 0 || k === n - 1) return 0;
      const p0 = axis === undefined ? wps[k - 1][field] : wps[k - 1][field][axis];
      const p1 = axis === undefined ? wps[k + 1][field] : wps[k + 1][field][axis];
      return (p1 - p0) / (wps[k + 1].at - wps[k - 1].at);
    };
    const at = (p0, p1, m0, m1) => h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1;
    return {
      center: [
        at(a.center[0], b.center[0], tangent(i, 'center', 0), tangent(i + 1, 'center', 0)),
        at(a.center[1], b.center[1], tangent(i, 'center', 1), tangent(i + 1, 'center', 1)),
      ],
      zoom: at(a.zoom, b.zoom, tangent(i, 'zoom'), tangent(i + 1, 'zoom')),
      bearing: a.bearing !== undefined && b.bearing !== undefined ? lerp(a.bearing, b.bearing, f) : 0,
      pitch: a.pitch !== undefined && b.pitch !== undefined ? lerp(a.pitch, b.pitch, f) : 0,
    };
  }
  return wps[n - 1];
}

function cameraAt(camera, s) {
  const wps = camera.waypoints;
  if (!wps || wps.length === 0) return null;
  if (wps.length === 1 || s <= wps[0].at) return wps[0];
  if (s >= wps[wps.length - 1].at) return wps[wps.length - 1];
  if (camera.pathName === 'spline') return cameraAtSpline(camera, s);
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    if (s >= a.at && s <= b.at) {
      const f = easingFn(camera.easingName || 'smoothstep')(SEG([a.at, b.at], s));
      return {
        center: [lerp(a.center[0], b.center[0], f), lerp(a.center[1], b.center[1], f)],
        zoom: lerp(a.zoom, b.zoom, f),
        bearing: a.bearing !== undefined && b.bearing !== undefined ? lerp(a.bearing, b.bearing, f) : 0,
        pitch: a.pitch !== undefined && b.pitch !== undefined ? lerp(a.pitch, b.pitch, f) : 0,
      };
    }
  }
  return wps[wps.length - 1];
}

// ---------------- stripe canvas (screen-space, spec §7.5) ----------------
// Verdict round 25 (Ben, leander-07/08/10): exclusion stripes must not slide
// against the basemap during camera moves. The pattern phase now anchors to
// the Web-Mercator ground plane: drawStripesTo takes an optional
// `ground = { k, tx, ty }` transform (screen = anchor_screen + k · drawing-px,
// k = 2^(zoom − opening-zoom)) and the grid translates + scales with the map
// exactly like basemap geometry — still a 2D-canvas overlay, never
// fill-pattern (no tile anchoring, no seams). Assumes bearing 0 / pitch 0
// (map.project = similarity) — every scene to date. The outside-Playfield
// mask stays screen-space (its stripes never flowed against anything).
function drawStripesTo(ctx, opts) {
  const { w, h, spacing, weight, angleDeg, color, ground } = opts;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = weight;
  ctx.lineCap = 'butt';
  if (ground) ctx.setTransform(ground.k, 0, 0, ground.k, ground.tx, ground.ty);
  // constant phase: lines anchored consistently at the plane origin for the
  // given angle — direction vector rotated, offset multiples of spacing
  const rad = (angleDeg * Math.PI) / 180;
  const dir = [Math.cos(rad), Math.sin(rad)];
  const normal = [-dir[1], dir[0]];
  // project the viewport corners onto the normal to bound the stripe offsets
  // (ground transform: corners in drawing space = inverse-transformed screen)
  const x0 = ground ? -ground.tx / ground.k : 0;
  const y0 = ground ? -ground.ty / ground.k : 0;
  const x1 = ground ? (w - ground.tx) / ground.k : w;
  const y1 = ground ? (h - ground.ty) / ground.k : h;
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  const dots = corners.map(([x, y]) => x * normal[0] + y * normal[1]);
  const minOff = Math.min(...dots), maxOff = Math.max(...dots);
  // Ticket 06 (leander-21 verdict): stripe segments are centered on the
  // drawing-space ORIGIN, so the half-length must reach the FARTHEST viewport
  // corner from that origin — the old viewport-diagonal L under-reached once
  // the ground transform pushed the viewport far from the origin (big zoom
  // deltas), leaving an unstriped wedge at the far corner along the stripe
  // direction. Static cameras (ground = null) reduce to the old value.
  const L = Math.max(
    Math.hypot(x0, y0), Math.hypot(x1, y0),
    Math.hypot(x0, y1), Math.hypot(x1, y1)
  ) + spacing * 2;
  for (let k = Math.floor(minOff / spacing) * spacing; k <= maxOff + spacing; k += spacing) {
    // line through origin offset k along the normal: base point = normal*k
    const cx = normal[0] * k, cy = normal[1] * k;
    ctx.moveTo(cx - dir[0] * L, cy - dir[1] * L);
    ctx.lineTo(cx + dir[0] * L, cy + dir[1] * L);
  }
  ctx.stroke();
  ctx.restore();
}

function stripePath(ctx, coords, project) {
  // NOTE: no beginPath here — callers accumulate multiple exclusions into one
  // path (union fill / subtraction mask) and must open the path themselves.
  coords.forEach((ring, ri) => {
    ring.forEach((ll, i) => {
      const p = project(ll);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  });
}

// geometry union via fill-mask compositing (evenodd would hole intersections);
// outline trimmed where the segment midpoint lies inside another exclusion
//
// leander-08 verdict (two-pass compositing): the old single union pass made
// every exclusion stripe the WHOLE union — a blinking exclusion flooded the
// already-excluded area with its stripes (the old area visibly pulsed along)
// and the new area blinked against a striped baseline instead of the bare
// basemap, flattening the blink rhythm to a barely-visible density wiggle.
// Now: settled exclusions (alpha ≥ 0.999) stripe their union once; each
// blinking exclusion stripes ONLY its own rings minus every other active
// exclusion's region (offscreen mask, evenodd — holes respected), so only
// the newly excluded area blinks and the union still reads as one shape.
//
// Ticket 06 verdict (leander-08 round 3, "weird line at the western tip"):
// the settled union used ctx.clip('nonzero') over a path whose rings reach
// ±3000–5000 px offscreen (large region-scale shapes reach far past the viewport).
// Skia's CLIP-MASK rasterizer loses precision on such paths and leaks thin
// off-grid stripe fragments along in-canvas clip edges (verified A/B: the
// fragment follows the z2 closure edge, winding math + solid-fill clip are
// exact, and a fill()+destination-in composite of the SAME path is clean).
// Fix: no clip() in this pass — stripes are drawn full-canvas on a scratch
// layer, the union polygon is FILLED into a mask (fill is exact), and the
// layer is composited via destination-in. Blink pass already worked this way.
function drawExclusions(ctx, exclusions, project, w, h, metrics) {
  const active = exclusions.filter((e) => e.alpha > 0);
  if (!active.length) return;
  const settled = active.filter((e) => e.alpha >= 0.999);
  const blinking = active.filter((e) => e.alpha < 0.999);
  const ground = metrics.ground || null;

  if (settled.length) {
    const mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const m = mask.getContext('2d');
    m.fillStyle = '#000';
    // ben-04 verdict: one fill PER EXCLUSION — the old single-path nonzero
    // union wound mixed-orientation rings to 0 in the overlap and holed the
    // union exactly where exclusions intersected (a CW ring next to CCW
    // neighbors un-excluded the shared area on settle)
    for (const e of settled) {
      m.beginPath();
      stripePath(m, e.resolvedCoords, project);
      m.fill('nonzero');
    }

    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const lg = layer.getContext('2d');
    drawStripesTo(lg, { w, h, spacing: metrics.spacing, weight: metrics.weight, angleDeg: metrics.angle, color: metrics.stripe, ground });
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(mask, 0, 0);

    ctx.drawImage(layer, 0, 0);
  }

  // Blink pass (renderer law, round 98): exclusions with an identical entry (recipe + window +
  // overrides) blink as ONE group. Drawing them separately made each group
  // member subtract the other's region, so their overlap was erased by both
  // and stayed unstriped for the whole blink (oskar-09's two simultaneous
  // circles: a hole at the lens centre until settle). The group is striped
  // once as a union (one nonzero fill per exclusion → winding-proof) and
  // subtracts only exclusions outside the group.
  const groups = new Map();
  for (const e of blinking) {
    const key = JSON.stringify(e.entry || {});
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const group of groups.values()) {
    const mask = document.createElement('canvas');
    mask.width = w;
    mask.height = h;
    const m = mask.getContext('2d');
    m.fillStyle = '#000';
    for (const e of group) {
      m.beginPath();
      stripePath(m, e.resolvedCoords, project);
      m.fill('nonzero');
    }

    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const lg = layer.getContext('2d');
    drawStripesTo(lg, { w, h, spacing: metrics.spacing, weight: metrics.weight, angleDeg: metrics.angle, color: metrics.stripe, ground });
    lg.globalCompositeOperation = 'destination-in';
    lg.drawImage(mask, 0, 0);
    lg.globalCompositeOperation = 'destination-out';
    for (const o of active) {
      if (group.includes(o)) continue;
      lg.beginPath();
      stripePath(lg, o.resolvedCoords, project);
      lg.fill('nonzero');
    }

    ctx.save();
    ctx.globalAlpha = group[0].alpha;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  // outlines, trimmed where they overlap another exclusion. Verdict round 4
  // (ticket 06): the old whole-edge midpoint test left corners/edge stubs
  // visible where only part of an edge lies inside the neighbor (e.g. a box
  // corner poking into an overlap). Edges are now subdivided to ~6px screen
  // pieces and each piece is tested at its own midpoint, so the outline
  // disappears across the *entire* shared boundary and the union reads as one
  // continuous shape at any overlap geometry.
  //
  // Perf (round 70, ben-26): the naive per-piece test re-projected every
  // other exclusion's rings per piece — with region-scale exclusions at high
  // zoom (bbox-inverse shapes at z15+ project ~50k-px edges → ~9k pieces per
  // edge) that became millions of point projections per frame (3.3 s/frame on
  // ben-26 vs the historical 0.3-1 s). All rings are now projected ONCE per
  // call (screen-space pts + per-ring bbox); a piece only ray-casts rings
  // whose bbox contains its midpoint. Output-identical (rings outside the
  // midpoint's bbox contribute zero ray-cast toggles either way).
  const projActive = active.map((e) =>
    e.resolvedCoords.map((ring) => {
      const pts = ring.map(project);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { pts, bbox: [minX, minY, maxX, maxY] };
    })
  );
  const inOther = (pt, me) => {
    const [x, y] = pt;
    for (let oi = 0; oi < projActive.length; oi++) {
      if (oi === me) continue;
      let inside = false;
      for (const { pts, bbox } of projActive[oi]) {
        if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) continue;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
          if (hit) inside = !inside;
        }
      }
      if (inside) return true;
    }
    return false;
  };
  ctx.save();
  ctx.strokeStyle = metrics.outlineColor;
  ctx.lineWidth = metrics.outlinePx;
  for (const [ei, e] of active.entries()) {
    if (e.alpha < 0.999) ctx.globalAlpha = Math.max(0, Math.min(1, e.alpha));
    else ctx.globalAlpha = 1;
    for (const { pts } of projActive[ei]) {
      for (let k = 0; k < pts.length - 1; k++) {
        const ax = pts[k].x, ay = pts[k].y;
        const bx = pts[k + 1].x, by = pts[k + 1].y;
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / 6));
        for (let j = 0; j < n; j++) {
          const t0 = j / n, tm = (j + 0.5) / n;
          const mx = ax + (bx - ax) * tm, my = ay + (by - ay) * tm;
          if (inOther([mx, my], ei)) continue;
          ctx.beginPath();
          ctx.moveTo(ax + (bx - ax) * t0, ay + (by - ay) * t0);
          ctx.lineTo(ax + (bx - ax) * ((j + 1) / n), ay + (by - ay) * ((j + 1) / n));
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}

function pointInRings(pt, coords, project) {
  // ray-cast in screen space over the projected outer ring(s)
  const [x, y] = pt;
  let inside = false;
  for (const ring of coords) {
    const pts = ring.map(project);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
  }
  return inside;
}

// outside-playfield mask: plum fill + cream stripes over everything outside
// the city ring, painted LAST so exclusions read behind the boundary.
// Round 26: ground-anchored like the exclusion stripes (same `ground`
// transform) — both stripe fields ride the camera identically.
function drawOutsideMask(ctx, playfieldRings, project, w, h, metrics) {
  if (!playfieldRings) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  for (const ring of playfieldRings) {
    ring.forEach((ll, i) => {
      const p = project(ll);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }
  ctx.clip('evenodd');
  ctx.globalAlpha = 1;
  ctx.fillStyle = metrics.fill;
  ctx.fillRect(0, 0, w, h);
  drawStripesTo(ctx, { w, h, spacing: metrics.spacing, weight: metrics.weight, angleDeg: metrics.angle, color: metrics.stripe, ground: metrics.ground || null });
  ctx.restore();
}

// ride segment highlight: official line color with equal-length white
// segments oriented along the band direction (screen-space dash pattern in
// px along the projected path — dashes follow the polyline natively, static
// within the window; motion belongs to the pin, not the highlight)
function toPts(geom) {
  return geom.type === 'MultiLineString' ? geom.coordinates : [geom.coordinates];
}

function sliceLineByStations(lineGeom, stationsMap, fromSlug, toSlug) {
  const parts = toPts(lineGeom);
  const stationCoord = (slug) => stationsMap[slug];
  const from = stationCoord(fromSlug);
  const to = stationCoord(toSlug);
  if (!from || !to) return null;
  const nearestOn = (pts, target) => {
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const dx = p[0] - target[0];
      const dy = p[1] - target[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  // choose the part that contains both stations closest together
  let bestPart = null;
  let bestSpan = -1;
  for (const pts of parts) {
    const iF = nearestOn(pts, from);
    const iT = nearestOn(pts, to);
    const span = Math.abs(iF - iT);
    if (span > bestSpan) { bestSpan = span; bestPart = pts; }
  }
  const pts = bestPart || parts[0];
  const iF = nearestOn(pts, from);
  const iT = nearestOn(pts, to);
  const [lo, hi] = iF <= iT ? [iF, iT] : [iT, iF];
  const seg = pts.slice(lo, hi + 1);
  if (iF > iT) seg.reverse();
  // ensure endpoints are the exact station nodes — after the optional
  // reverse, index 0 is always the FROM-station's node and the last index
  // the TO-station's node (verdict round 30, leander-13: the ternaries here
  // had inverted polarity for the iF > iT case, snapping the wrong ends and
  // drawing the band as a doubled scribble whenever a ride ran against the
  // line's stored vertex order)
  if (seg.length >= 2) {
    seg[0] = from;
    seg[seg.length - 1] = to;
  }
  return seg.length >= 2 ? seg : null;
}

// point at fractional progress (0–1 arc-length) along a polyline —
// used by from-progress/to-progress pin moves (verdict round 21, ticket 06)
function pointAtProgress(pts, t) {
  if (!pts || pts.length < 2) return null;
  const clamped = clamp01(t);
  let total = 0;
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const l = Math.sqrt(dx * dx + dy * dy);
    lens.push(l);
    total += l;
  }
  if (total === 0) return pts[0];
  let target = total * clamped;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) {
      const f = lens[i] === 0 ? 0 : target / lens[i];
      return [
        lerp(pts[i][0], pts[i + 1][0], f),
        lerp(pts[i][1], pts[i + 1][1], f),
      ];
    }
    target -= lens[i];
  }
  return pts[pts.length - 1];
}

// spherical circle rim (v1.5): n positions clockwise from north around
// [lon0, lat0] at great-circle radius r meters — the same sampling the geo
// conventions use for hand-authored radius shapes (scenes/shapes/). Open ring
// (no repeated first position) — the drawer wraps the arc itself.
function circleRing([lon0, lat0], rMeters, n) {
  const R = 6371000;
  const d = rMeters / R;
  const rad = (x) => (x * Math.PI) / 180;
  const deg = (x) => (x * 180) / Math.PI;
  const phi0 = rad(lat0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n; // 0 = north, clockwise (E at th=π/2)
    const lat = deg(Math.asin(Math.sin(phi0) * Math.cos(d) + Math.cos(phi0) * Math.sin(d) * Math.cos(th)));
    const lon = lon0 + deg(
      Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(phi0), Math.cos(d) - Math.sin(phi0) * Math.sin(rad(lat)))
    );
    pts.push([lon, lat]);
  }
  return pts;
}

// draw the visible rim arc: positions [0..n] with the ring wrapped
// (progress 1 = closed); stroke in screen space, projected per frame —
// camera moves stay correct (same law as segments).
// Round 98 — union outline: rim pieces whose midpoint lies inside another active
// circle's projected disc are skipped (the exclusion-outline-trim law applied
// to circles), so overlapping context circles read as one silhouette with no
// arc crossing the shared area. `others` = [{ pts, bbox }] of the other
// circles' projected rings (page.js builds them once per frame).
function drawCircle(ctx, circle, project, w, h, others) {
  if (circle.alpha <= 0 || circle.progress <= 0 || !circle.resolvedCoords) return;
  const pts = circle.resolvedCoords;
  const n = pts.length;
  const full = Math.floor(circle.progress * n); // drawn vertex count
  if (full < 2) return;
  const proj = [];
  for (let i = 0; i <= full; i++) proj.push(project(pts[i % n]));
  const insideOther = (x, y) => {
    for (const { pts: cp, bbox } of others || []) {
      if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) continue;
      let inside = false;
      for (let i = 0, j = cp.length - 1; i < cp.length; j = i++) {
        const xi = cp[i].x, yi = cp[i].y, xj = cp[j].x, yj = cp[j].y;
        const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (hit) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  ctx.save();
  ctx.globalAlpha = circle.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = CIRCLE_COLOR;
  ctx.lineWidth = circle.lineWidth || 5;
  let open = false;
  for (let i = 0; i < full; i++) {
    const a = proj[i], b = proj[i + 1];
    if (insideOther((a.x + b.x) / 2, (a.y + b.y) / 2)) {
      if (open) { ctx.stroke(); open = false; }
      continue;
    }
    if (!open) { ctx.beginPath(); ctx.moveTo(a.x, a.y); open = true; }
    ctx.lineTo(b.x, b.y);
  }
  if (open) ctx.stroke();
  ctx.restore();
}

// clip subsequent stripe-canvas drawing to the Playfield (inside the
// rings) — used for elements painted AFTER the outside mask (segments,
// circles), whose screen-space strokes would otherwise run past the boundary.
function clipToRings(ctx, rings, project) {
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((ll, i) => {
      const p = project(ll);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
  }
  ctx.clip('evenodd');
}

// ground-space helpers (round 70): invert the stripe ground transform
// (screen = k·d + t) so dash phases can anchor to the ground plane. The
// d-space origin is the anchor camera's screen space — d-arc distances are
// ground-locked screen-px at the anchor zoom.
function toGroundSpace(pts, ground) {
  const { k, tx, ty } = ground;
  return pts.map((p) => [(p.x - tx) / k, (p.y - ty) / k]);
}

function fromGroundSpace(pts, ground) {
  const { k, tx, ty } = ground;
  return pts.map(([x, y]) => [k * x + tx, k * y + ty]);
}

// cumulative arc length per vertex (cum[0] = 0)
function cumArcs(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return cum;
}

  // dash intervals [s0, s1] in arc space for a [dash, gap] pattern whose
  // phase starts at o (arc of the first dash front). Matches the canvas
  // law `lineDashOffset = −t·flow` (forward crawl, verdict round 5): there
  // dash arcs sit at (a + L) mod period ∈ [0, dash) with L = −t·flow →
  // dash set = [t·flow mod period + m·period, …] — phase o positive and
  // INCREASING with t (round 70 fix: the first cut passed −t·flow and
  // crawled backwards, toward the path start).
function dashIntervals(total, dash, gap, o) {
  const period = dash + gap;
  const out = [];
  for (let a = o; a < total; a += period) {
    const s0 = Math.max(a, 0);
    const s1 = Math.min(a + dash, total);
    if (s1 > s0) out.push([s0, s1]);
  }
  return out;
}

// sub-polyline between arc s0..s1, endpoints interpolated exactly (the
// pathPrefix law both-ends), mapped back to screen via the ground transform
function arcSlice(pts, cum, s0, s1, ground) {
  const lerp2 = (i, s) => {
    const l = cum[i + 1] - cum[i];
    const f = l === 0 ? 0 : (s - cum[i]) / l;
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] <= s0 || cum[i] >= s1) continue;
    const a = cum[i] >= s0 ? pts[i] : lerp2(i, s0);
    const b = cum[i + 1] <= s1 ? pts[i + 1] : lerp2(i, s1);
    if (!out.length) out.push(fromGroundSpace([a], ground)[0]);
    out.push(fromGroundSpace([b], ground)[0]);
  }
  return out;
}

function drawRide(ctx, ride, project, metrics) {
  if (ride.alpha <= 0 || !ride.resolvedCoords || ride.resolvedCoords.length < 2) return;
  const pts = ride.resolvedCoords.map(project);

  // Ben's verdict round (ticket 06): ride = alternating equal-length
  // segments of official line color and white, oriented along the ride
  // direction ("in Fahrtrichtung") — the BVG "Linie wird geritten" look.
  // setLineDash is screen-space px measured along the path, so segments
  // follow the polyline natively; caps are butt, not round: round caps
  // would bleed lineWidth/2 of every color dash into the white gaps
  // (34px color vs 18px white at 8px width), breaking the equal-length
  // law; round lineJoin stays for corners.
  //
  // Verdict round 4 (ticket 06): denser striping (dash/gap from the recipe,
  // 26→14) and a white outline around the band — a white underlay stroke
  // (width + 2×outline-px) beneath everything, so the outline reads on both
  // sides of the band without breaking the equal-length dash law.
  //
  // Verdict round 5 (ticket 06, Ben): the color dashes CRAWL in
  // Fahrtrichtung — dash phase advances along the path at
  // ride-highlight.flow-px-per-s (negative lineDashOffset = forward);
  // deterministic from t = frame/24. The band geometry itself stays static
  // (motion belongs to the stripes, not the line).
  //
  // Verdict round 70 (ticket 06, ben-26): the dash phase is GROUND-ANCHORED
  // (round-25 law, same as the exclusion stripes): the pattern lives in the
  // anchor camera's screen space and rides the map under zooming cameras.
  // The old screen-path anchoring re-anchored every dash to the path's
  // projected start point — under ben-26's z13.8→15.6 push that start point
  // (Ostkreuz, off-screen west) swept west at hundreds of px/s and dragged
  // the dashes backwards across the map. Dash screen size now breathes with
  // the zoom like the stripe pitch does; static-anchor cameras (k = 1,
  // single-waypoint / no camera) are pixel-identical to the old law.
  ctx.save();
  ctx.globalAlpha = ride.alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));

  // 1) white outline underlay (band width + 2× outline)
  const outlinePx = metrics.outlinePx || 0;
  if (outlinePx > 0) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = metrics.lineWidth + outlinePx * 2;
    ctx.setLineDash([]);
    ctx.stroke();
  }

  // 2) white base stroke → the white segments between color dashes
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = metrics.lineWidth;
  ctx.setLineDash([]);
  ctx.stroke();
  // 3) official line color dashes on top (dash == gap → equal lengths),
  // phase advanced along the path over time (flow-px-per-s), ground-anchored
  ctx.strokeStyle = ride.color;
  const g = metrics.ground || { k: 1, tx: 0, ty: 0 };
  const d = toGroundSpace(pts, g);
  const cum = cumArcs(d);
  const total = cum[cum.length - 1];
  const period = metrics.dash + metrics.gap;
  const o = ((ride.t ?? 0) * (metrics.flowPxPerS || 0)) % period;
  ctx.beginPath();
  for (const [s0, s1] of dashIntervals(total, metrics.dash, metrics.gap, o)) {
    const seg = arcSlice(d, cum, s0, s1, g);
    seg.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  }
  ctx.stroke();
  ctx.restore();
}

// walking-path draw-on (v1.12, additive): the tip grows along the
// hand-authored polyline from coords[0] toward the last coord over draw-in
// at the window start and retracts over draw-out at the window end (the
// segment-draw law along a multi-point route); fade smooths both edges.
// progress ∈ [0, 1] = arc-length fraction of the full polyline; alpha is the
// clamped fade law. draw-in/out default 0 in path-highlight — the plain
// ride-highlight fade (ben-07: draw-in 2 s tip draw, fade-out 0 hold).
// v1.21 `append`: the path keeps its already-walked prefix (arc-length
// fraction `append.from`) drawn from the window start and grows the remaining
// suffix from `append.from` → 1 over `append.window`. One path object, so the
// dash phase runs continuously across the historical trace and the live leg
// (no seam at the junction). `append` REPLACES draw-in/draw-out (the path is
// always at least its walked prefix); the path window still controls alpha.
function pathState(path, s) {
  const p = paramSet('path-highlight', path.overrides);
  const [a, b] = path.window;
  const dur = b - a;
  const di = Math.min(p['draw-in'], dur / 2);
  const do_ = Math.min(p['draw-out'], dur / 2);
  const fi = Math.min(p['fade-in'], dur / 2);
  const fo = Math.min(p['fade-out'], dur / 2);
  if (s < a || s >= b) return { alpha: 0, progress: 0 };
  let progress;
  if (path.append) {
    const ap = path.append;
    const [ga, gb] = ap.window;
    const from = ap.from;
    const ef = ap.easing ? (EASINGS[ap.easing] || smoothstep) : smoothstep;
    progress = s < ga ? from
      : s >= gb ? 1
      : from + (1 - from) * ef((s - ga) / (gb - ga));
  } else {
    progress =
      s < a + di ? smoothstep((s - a) / di)
      : s > b - do_ ? 1 - smoothstep((s - (b - do_)) / do_)
      : 1;
  }
  const inA = fi > 0 ? smoothstep((s - a) / fi) : 1;
  const outA = fo > 0 ? 1 - smoothstep((s - (b - fo)) / fo) : 1;
  return { alpha: Math.min(inA, outA), progress };
}

// arc-length polyline prefix: the drawn part up to `progress` of the full
// screen-space length, last vertex interpolated exactly (no vertex snapping —
// hand-authored routes have few, far-apart vertices; a 128-segment-style
// vertex walk would pop between corners)
function pathPrefix(pts, progress) {
  if (!pts || pts.length < 2) return pts || [];
  const lens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens.push(l);
    total += l;
  }
  if (total <= 0) return [pts[0]];
  let target = total * clamp01(progress);
  const out = [pts[0]];
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i]) {
      const f = lens[i] === 0 ? 0 : target / lens[i];
      out.push([lerp(pts[i][0], pts[i + 1][0], f), lerp(pts[i][1], pts[i + 1][1], f)]);
      return out;
    }
    out.push(pts[i + 1]);
    target -= lens[i];
  }
  return out;
}

// walking-route highlight (v1.12): the ride-highlight look along a
// hand-authored polyline — grey band, white outline underlay, alternating
// equal-length white segments crawling in route direction (coords order) at
// path-highlight.flow-px-per-s. Projected per frame (camera moves stay
// correct); clipped to the pathPrefix arc-length prefix so the draw-on tip
// and the dash crawl compose. Round 70: dashes ground-anchored like rides
// (see drawRide) — under zooming cameras the dashes ride the map instead of
// re-anchoring to the route's projected start point.
function drawPath(ctx, path, project, metrics) {
  if (path.alpha <= 0 || path.progress <= 0 || !path.resolvedCoords || path.resolvedCoords.length < 2) return;
  const g = metrics.ground || { k: 1, tx: 0, ty: 0 };
  const dAll = path.resolvedCoords.map((ll) => {
    const p = project(ll);
    return [(p.x - g.tx) / g.k, (p.y - g.ty) / g.k];
  });
  const cut = pathPrefix(dAll, path.progress);
  if (cut.length < 2) return;
  const screenCut = fromGroundSpace(cut, g);
  ctx.save();
  ctx.globalAlpha = path.alpha * (metrics.opacity ?? 1);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.beginPath();
  screenCut.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  // 1) white outline underlay (band width + 2× outline) — same law as rides
  const outlinePx = metrics.outlinePx || 0;
  if (outlinePx > 0) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = metrics.lineWidth + outlinePx * 2;
    ctx.setLineDash([]);
    ctx.stroke();
  }
  // 2) white base stroke → the white segments between color dashes (skipped
  // when a trace must not read as a ride band: `base: false` leaves the map
  // visible between dashes instead of a white underlay)
  if (metrics.base !== false) {
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = metrics.lineWidth;
    ctx.setLineDash([]);
    ctx.stroke();
  }
  // 3) route color dashes on top (dash == gap → equal lengths), phase
  // advanced along the route over time (flow-px-per-s), ground-anchored,
  // deterministic from t
  ctx.strokeStyle = metrics.color || '#3E4754';
  ctx.lineWidth = metrics.lineWidth;
  const cum = cumArcs(cut);
  const total = cum[cum.length - 1];
  const period = metrics.dash + metrics.gap;
  const o = ((path.t ?? 0) * (metrics.flowPxPerS || 0)) % period;
  ctx.beginPath();
  for (const [s0, s1] of dashIntervals(total, metrics.dash, metrics.gap, o)) {
    const seg = arcSlice(cut, cum, s0, s1, g);
    seg.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------- camera / stripe entry ----------------
if (typeof window !== 'undefined') {
  window.__interp = {
    clamp01, smoothstep, linear, EASINGS, lerp, SEG,
    recipeParams, paramSet, easingFn,
    exclusionAlpha, rideAlpha, labelAlpha, labelGrow, labelPulse, lineEntranceAlpha, pointAlpha, pinAlpha, segmentState, circleState, pathState, pinPosition, cameraAt,
    drawStripesTo, stripePath, drawExclusions, drawOutsideMask,
    sliceLineByStations, drawRide, pointInRings, pointAtProgress, circleRing, drawCircle, clipToRings, pathPrefix, drawPath,
  };
}