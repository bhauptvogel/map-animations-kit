// page.js — browser-side runtime: map init, sources, DOM builders, __frame.
// Historical comments reference scene names from the production project this
// kit was extracted from. They document why a law exists; they are not data.
// Loaded after interpreter.js; inject.js (window.__SCENE_JSON / __GEO /
// __PLAYFIELD / __RECIPES) is served by the loopback server before this file.

'use strict';

(function () {
  const P = window.__interp;
  const FRAMING = window.__SCENE_JSON.scene.framing;
  const HALF = FRAMING === 'half';
  const HALF_RIGHT = FRAMING === 'half-right'; // v1.13: mirror of half — 806px right strip
  const HALF_BOTTOM = FRAMING === 'half-bottom';
  const FPS = 24;
  const scene = window.__SCENE_JSON;
  const geo = window.__GEO; // { stations, stationNames, lines: {slug: {color, feature}} }
  const recipes = window.__RECIPES;
  const playfield = window.__PLAYFIELD || null; // optional Feature / FeatureCollection
  const playfieldRings = window.__PLAYFIELD_RINGS || []; // [[ [lon,lat], … ] …]
  const shapes = window.__SHAPES || {}; // slug → GeoJSON Polygon/MultiPolygon

  // frozen round-7 tokens (ticket 02 KB) — canvas-side
  const VIOLET = '#623CEA';
  const PLUM = '#54426B';
  const EXCL_STRIPE = 'rgba(98,60,234,0.50)';
  // verdict round 2 (ticket 06, Ben): outside-mask stripes cream → lighter
  // desaturated plum. Round-7 table lists cream rgba(231,223,198,0.30) here;
  // the cream read grey-violet over the plum fill. Stripes stay striped and
  // 45° — only the stripe hue moves into the plum family. Blend over the
  // #54426B fill lands ≈ #624F7D (subtle, same-family contrast).
  // verdict round 16 (ticket 06, Ben): outside area draws less attention —
  // fill #54426B → #4E4356 (HSL sat 23%→12%, L 34%→30%), stripe
  // rgba(130,108,164,0.32) → rgba(118,101,134,0.32). Same-family contrast kept.
  // verdict round 18 (ticket 06, Ben): dark band still dominated the frame —
  // value relationship flipped: outside goes LIGHT and near-neutral
  // (fill #4E4356 → #CBC7D1, L 30%→80%, sat ~10%) so the Playfield holds all
  // the contrast; stripes flip darker-than-fill rgba(122,115,134,0.40).
  // verdict round 19 (ticket 06, Ben): stripes liked, fill too light —
  // "much darker grey": fill #CBC7D1 → #44404A (L 80%→27%, sat ~6%).
  // verdict round 20 (ticket 06, Ben): pure-violet stripe read "very violet"
  // again over the dark fill — stripe moves to a muted violet-grey
  // rgba(104,88,140,0.30), blending to ≈ #4F475E: dark grey with a violet
  // accent, not a violet field.
  const PLUM_STRIPE = 'rgba(104,88,140,0.30)';
  const OUTSIDE_FILL = '#44404A';
  // verdict round 2 (ticket 06, Ben): pins leave the violet/plum family —
  // Seekers dark desaturated green, Hider dark desaturated red (both read on
  // the cool-neutral basemap; round-7 table has no pin color row — divergence noted)
  // verdict round 6 (ticket 06, Ben): Seekers green → dark blue #274F7C;
  // Hider stays dark red
  const PIN_SEEKERS = '#274F7C';
  const PIN_HIDER = '#8C3A2E';
  // free points + segments (leander-07): free points render in the station
  // label vocabulary but black + slightly thinner (scene-06 verdict round);
  // segments take the exclusion's violet — same blue as the excluded zone
  const POINT_COLOR = '#1A1A1A';
  const SEGMENT_COLOR = '#623CEA';
  // context circles (v1.5): same violet as segments — "context, not yet
  // excluded" (leander-15)
  const CIRCLE_COLOR = '#623CEA';
  // walking routes (v1.12, ben-07): the ride-highlight look in grey — the
  // band color is this frozen token, not a recipe param; #3E4754 is the
  // basemap's own dark slate grey (style.json palette) so the route reads
  // "neutral infrastructure" next to the colored transit bands. Per-path
  // scene color is allowed (points v1.8 exception class) via paths[].color.
  const PATH_COLOR = '#3E4754';

  // stripe metrics from the registry (renderer-wide recipes, kinds: [])
  function stripeMetrics() {
    const es = recipes['exclusion-stripes'].params;
    const op = recipes['outside-playfield'].params;
    const rh = recipes['ride-highlight'].params;
    const ph = recipes['path-highlight'] ? recipes['path-highlight'].params : null;
    return {
      excl: { spacing: es['spacing-px'].default, weight: es['weight-px'].default, angle: es['angle-deg'].default, outline: es['outline-px'].default },
      outside: { spacing: op['spacing-px'].default, weight: op['weight-px'].default, angle: op['angle-deg'].default },
      ride: { dash: rh['dash-px'].default, gap: rh['gap-px'].default, outline: rh['outline-px'] ? rh['outline-px'].default : 0, flow: rh['flow-px-per-s'] ? rh['flow-px-per-s'].default : 0 },
      path: ph ? { dash: ph['dash-px'].default, gap: ph['gap-px'].default, outline: ph['outline-px'].default, flow: ph['flow-px-per-s'].default } : null,
    };
  }
  const M = stripeMetrics();

  // ---------------- map init ----------------
  const pmtilesProtocol = new pmtiles.Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

  const mapEl = document.getElementById('map');
  // half framings cover 42% of the frame, not 50% (verdict round 15, Ben):
  // half: 806px left strip; half-bottom: 1920×454 strip at the bottom;
  // full: whole frame (verdict round 7, ticket 06: half-bottom framing)
  const HALF_W = 806;   // 42% of 1920
  const HALF_B_H = 454; // 42% of 1080
  mapEl.style.width = (HALF || HALF_RIGHT) ? HALF_W + 'px' : '1920px';
  mapEl.style.height = HALF_BOTTOM ? HALF_B_H + 'px' : '1080px';
  if (HALF_BOTTOM) {
    mapEl.style.top = (1080 - HALF_B_H) + 'px';
    mapEl.style.left = '0';
  }
  if (HALF_RIGHT) {
    mapEl.style.left = (1920 - HALF_W) + 'px';
  }
  const canvasW = (HALF || HALF_RIGHT) ? HALF_W : 1920;
  const canvasH = HALF_BOTTOM ? HALF_B_H : 1080;

  // slide wrapper (round 9): map + stripes + divider all slide in together
  // from the transparent edge; transform is set per-frame in __frame
  const stage = document.getElementById('stage');
  const stripesEl = document.getElementById('stripes');
  const slideWrap = document.createElement('div');
  slideWrap.id = 'slide-wrap';
  slideWrap.style.position = 'absolute';
  slideWrap.style.inset = '0';
  slideWrap.style.pointerEvents = 'none';
  // move map + stripes canvas into the wrapper (keep stage's z-index position)
  stage.replaceWith(slideWrap);
  slideWrap.appendChild(mapEl);
  slideWrap.appendChild(stripesEl);
  // divider: drawn on the stripe canvas (round 12 fix) — a DOM sibling with a
  // background above the WebGL map misaligns the map's composited layer in
  // headless screenshots (10px = divider height cut from the strip bottom).
  // Colors/geometry here; slide-in rides the same canvas automatically.
  const DIVIDER = { color: '#54426B', thickness: 10 };

  const firstWp = scene.camera && scene.camera.waypoints && scene.camera.waypoints[0];
  if (scene.camera) {
    // recipe easing default + per-scene override → cameraAt (recipe owns the
    // interpolation law; camera.overrides.easing validated by the validator,
    // applied here via the same paramSet path as rides/labels/pins)
    const wg = window.__RECIPES['waypoint-glide'] || { params: {} };
    const base = (wg.params.easing || {}).default || 'smoothstep';
    const ov = (scene.camera.overrides || {}).easing;
    scene.camera.easingName = ov !== undefined ? ov : base;
    // v1.15: `path` selects segment-wise easing (default) or one continuous
    // spline through all waypoints (interior waypoints passed at speed)
    const basePath = (wg.params.path || {}).default || 'segment';
    const ovPath = (scene.camera.overrides || {}).path;
    scene.camera.pathName = ovPath !== undefined ? ovPath : basePath;
  }
  const map = new maplibregl.Map({
    container: 'map',
    style: '/style/style.json',
    center: firstWp ? firstWp.center : [0, 0],
    zoom: firstWp ? firstWp.zoom : 10.2,
    bearing: 0, pitch: 0,
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    fadeDuration: 0,
  });
  window.__map = map;

  // ---------------- sources & layers (on style.load) ----------------
  map.on('style.load', () => {
    // Optional playfield outline. Without a boundary file the renderer skips
    // the outside-mask and the playfield clipping entirely.
    if (playfield) {
      map.addSource('playfield', { type: 'geojson', data: playfield });
      map.addLayer({
        id: 'playfield-outline', type: 'line', source: 'playfield',
        paint: { 'line-color': VIOLET, 'line-width': 2.0, 'line-dasharray': [2, 2] },
      });
    }

    // static Lines (always on from frame 0) — official color via ["get","color"]
    // (verdict round 2, ticket 06: width 10 → 6; round 4: 6 → 5; round 6: 5 → 4.5)
    for (const [slug, line] of Object.entries(geo.lines)) {
      map.addSource(`line-${slug}`, { type: 'geojson', data: line.feature });
      map.addLayer({
        id: `line-${slug}`, type: 'line', source: `line-${slug}`,
        paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': 0.95 },
      });
    }
    // v1.18 — optional street/path detail at close zooms (scene.streets).
    // The style ships the three layers hidden and at minzoom 14, so every
    // existing scene stays pixel-identical; scenes whose camera works at
    // z14+ opt in with top-level `streets: true`.
    if (scene.streets === true) {
      for (const id of ['road-tertiary-minor', 'road-service', 'road-path']) {
        map.setLayoutProperty(id, 'visibility', 'visible');
      }
    }
    window.__geoReady = true;
  });

  // ---------------- DOM: pins + labels ----------------
  // `photo` is repo-root-relative (scene-format) → serve from the loopback root
  const photoURL = (p) => `/${p.replace(/^\//, '')}`;
  function pinDOM(photoPath, color, labelText, tilt) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.style.setProperty('--pin-color', color);
    if (typeof tilt === 'number') el.style.setProperty('--pin-tilt', `${tilt}deg`);
    const inner = document.createElement('div');
    inner.className = 'pin-inner';
    const photo = document.createElement('div');
    photo.className = 'pin-photo';
    photo.style.setProperty('--pin-photo', `url("${photoURL(photoPath)}")`);
    const spikeWrap = document.createElement('div');
    spikeWrap.className = 'pin-spike-wrap';
    const spike = document.createElement('div');
    spike.className = 'pin-spike';
    spikeWrap.appendChild(spike);
    const label = document.createElement('div');
    label.className = 'pin-label';
    label.textContent = labelText;
    inner.append(photo, spikeWrap, label);
    el.append(inner);
    return el;
  }

  function stationMarkers(stationSlug, lineSlug, dotOnly, labelSide, labelDy, labelScale) {
    const color = lineSlug && geo.lines[lineSlug] ? geo.lines[lineSlug].color : '#224F86';
    const dotEl = document.createElement('div');
    dotEl.className = 'station-dot';
    dotEl.style.setProperty('--station-color', color);
    const inner = document.createElement('div');
    inner.className = 'station-dot-inner';
    dotEl.appendChild(inner);
    const innerEl = inner; // v1.4 dot-grow scales this element (--dot-scale)

    let name = null;
    let nameEl = null;
    if (!dotOnly) {
      nameEl = document.createElement('div');
      nameEl.className = 'station-name';
      nameEl.style.setProperty('--station-color', color);
      nameEl.textContent = geo.stationNames[stationSlug] || stationSlug;
      // v1.6 label-side/label-dy (leander-20): scene-authored placement —
      // "left" flips the text to the dot's west side (points[] round-24
      // vocabulary), label-dy shifts it vertically (px, negative = up).
      // __dx/__dy live on nameEl; the per-frame dot-grow offset reads them.
      const left = labelSide === 'left';
      const dy = labelDy || 0;
      // v1.14 label-scale: scene-authored text-size multiplier via CSS var
      // (never the dot — dot-scale/grow/pulse own that); default 1 = 27px
      if (labelScale !== undefined) nameEl.style.setProperty('--label-scale', String(labelScale));
      nameEl.__dx = left ? -24 : 24;
      nameEl.__dy = dy;
      name = subpixel(new maplibregl.Marker({
        element: nameEl, anchor: left ? 'right' : 'left',
        offset: [nameEl.__dx, dy],
      }))
        .setLngLat(geo.stations[stationSlug])
        .setOpacity('0')
        .addTo(map);
      // v1.4 dot-grow: shift the name marker so the text clears the grown
      // ring (offset grows with the same scale the dot gets)
    }

    const dot = subpixel(new maplibregl.Marker({ element: dotEl, anchor: 'center' }))
      .setLngLat(geo.stations[stationSlug])
      .setOpacity('0')
      .addTo(map);
    return { dot, name, innerEl, nameEl };
  }

  // Every marker rides the camera per frame via jumpTo, which fires moveend —
  // without subpixel positioning Marker._update rounds _pos to integer px on
  // every frame while the WebGL basemap + stripe canvas project sub-pixel
  // smoothly. The quantized marker then lags up to half a pixel and snaps
  // forward each time the error crosses 0.5px: a visible flicker of pins and
  // labels against the map on every zoom/pan (leander-08/10 verdict).
  function subpixel(marker) {
    marker.setSubpixelPositioning(true);
    return marker;
  }

  // pins (at most one each; labels are renderer constants, never scene fields)
  const pinMarkers = {}; // 'seekers' | 'hider' → Marker
  // pin start: station slug or free coord (v1.2) — the coord goes through the
  // same pin.stations map under a private key so pinPosition stays untouched
  function pinStartCoord(pin, kind) {
    if (pin.start.coord !== undefined) {
      const slug = `__${kind}__`;
      pin.stations[slug] = pin.start.coord;
      pin.startStation = slug;
      return;
    }
    pin.startStation = pin.start.station;
  }
  if (scene.seekers) {
    scene.seekers.stations = geo.stations; // slug → coord resolver for __frame
    pinStartCoord(scene.seekers, 'seekers');
    const pg = (window.__RECIPES['pin-glide'] || {}).params || {};
    scene.seekers.easingName = pg.easing ? pg.easing.default : 'smoothstep';
    pinMarkers.seekers = subpixel(new maplibregl.Marker({
      // verdict round 2 (ticket 06): Seekers = dark green #2D6A4F (was violet)
      // verdict round 16 (ticket 06, Ben): pin label "Seekers" → "Seeker"
      element: pinDOM(scene.seekers.photo, PIN_SEEKERS, 'Seeker', scene.seekers.tilt),
      anchor: 'bottom',
    })).setLngLat(scene.seekers.stations[scene.seekers.startStation]).addTo(map);
    pinMarkers.seekers.setOpacity('0');
  }
  if (scene.hider) {
    // Hider pin: seeker geometry with the dark-red hider token. Customize the
    // token here if your project uses a different hider identity.
    const hiderColor = PIN_HIDER;
    scene.hider.stations = geo.stations;
    pinStartCoord(scene.hider, 'hider');
    scene.hider.easingName = scene.seekers ? scene.seekers.easingName : 'smoothstep';
    pinMarkers.hider = subpixel(new maplibregl.Marker({
      element: pinDOM(scene.hider.photo, hiderColor, 'Hider', scene.hider.tilt),
      anchor: 'bottom',
    })).setLngLat(scene.hider.stations[scene.hider.startStation]).addTo(map);
    pinMarkers.hider.setOpacity('0');
  }

  for (const lb of scene.labels || []) {
    lb.__markers = stationMarkers(lb.station, lb.line, lb['dot-only'] === true, lb['label-side'], lb['label-dy'], lb['label-scale']);
    // v1.11 dot-scale: scene-authored base-size multiplier on the inner dot
    // (composes with pulse/grow — both ride the same element's --dot-scale)
    if (lb['dot-scale'] !== undefined) lb.__markers.innerEl.style.setProperty('--dot-base', String(lb['dot-scale']));
  }

  // lineEntrances (v1.3, additive): full Line geometry fades in mid-clip —
  // MapLibre line layer opacity per frame, driven by the line-fade recipe
  for (const le of scene.lineEntrances || []) {
    le.__layerId = `line-${le.line}`;
  }

  // free points: station-label look, black, thinner dot (leander-07).
  // Round 24 verdict: the pin renders ABOVE points (pin photo z-5 > label
  // z-4) — the earlier points-over-pin flip was reverted by Ben. Optional
  // "label-side": "left" flips the text to the dot's west side.
  for (const pt of scene.points || []) {
    const dotEl = document.createElement('div');
    dotEl.className = 'station-dot';
    // v1.8: per-point color (leander-22 hospital dots) — scene-authored hex,
    // default stays the frozen black free-point token
    dotEl.style.setProperty('--station-color', pt.color || POINT_COLOR);
    const inner = document.createElement('div');
    inner.className = 'station-dot-inner point-dot-inner';
    dotEl.appendChild(inner);
    const nameEl = document.createElement('div');
    nameEl.className = 'station-name point-name';
    nameEl.style.setProperty('--station-color', pt.color || POINT_COLOR);
    nameEl.textContent = pt.text;
    const left = pt['label-side'] === 'left';
    // v1.12: label-dy (px vertical offset, negative = up) — the labels v1.6
    // vocabulary completed for points
    const dy = pt['label-dy'] || 0;
    // v1.9: per-point scale (leander-22 hospitals) — dot + text scale via CSS
    // var; default 1 = frozen free-point size
    const ptScale = pt.scale || 1;
    inner.style.setProperty('--pt-scale', ptScale);
    nameEl.style.setProperty('--pt-scale', ptScale);
    pt.__dot = subpixel(new maplibregl.Marker({ element: dotEl, anchor: 'center' }))
      .setLngLat(pt.coord).setOpacity('0').addTo(map);
    pt.__name = subpixel(new maplibregl.Marker({
      element: nameEl, anchor: left ? 'right' : 'left', offset: left ? [-24, dy] : [24, dy],
    })).setLngLat(pt.coord).setOpacity('0').addTo(map);
  }

  // segments: straight lines between hand-authored coords — drawn on the
  // stripe canvas in screen space (drawn in drawStripesFrame, after the mask
  // but before the divider). Endpoints project per frame — the camera moves.

  // circles (v1.5, additive): hand-authored center + radius — the rim samples
  // once per scene (spherical, clockwise from north); drawn on the stripe
  // canvas in screen space after the mask (drawCircle in drawStripesFrame).
  for (const ci of scene.circles || []) {
    if (ci.__ring === undefined) {
      ci.__ring = P.circleRing(ci.center, ci['radius-m'], 128);
      ci.resolvedCoords = ci.__ring;
    }
  }

  // paths (v1.12, additive): hand-authored route polylines — the coords ARE
  // the geometry (hand-authoring exception class, no geo-db resolution);
  // projected per frame in drawPath.
  for (const pa of scene.paths || []) {
    if (pa.resolvedCoords === undefined) pa.resolvedCoords = pa.coords;
  }

  // ---------------- stripe canvas ----------------
  const stripeCanvas = stripesEl;
  stripeCanvas.width = canvasW;
  stripeCanvas.height = canvasH;
  if (HALF_BOTTOM) {
    stripeCanvas.style.top = (1080 - HALF_B_H) + 'px';
    stripeCanvas.style.left = '0';
  }
  if (HALF_RIGHT) {
    stripeCanvas.style.left = (1920 - HALF_W) + 'px';
  }
  const sctx = stripeCanvas.getContext('2d');
  const project = (ll) => map.project(ll);

  // Verdict round 26 (Ben, leander-07/08/10): BOTH stripe fields (exclusions
  // + outside-Playfield mask) anchor to the Web-Mercator ground plane — they
  // ride the camera like basemap geometry instead of sliding against it.
  // Scale reference = the scene's TIME-AVERAGE zoom (round-26 verdict;
  // round-28 REVERT of the round-27 global anchor-zoom experiment: a global
  // reference made tightly-zoomed future scenes show very wide stripes).
  // The anchor is the numeric integral of the eased waypoints over scene
  // length; spacing-px is exact there. A static camera (single waypoint /
  // no camera) reduces to that zoom.
  const anchorWp = scene.camera && scene.camera.waypoints && scene.camera.waypoints[0];
  const groundAnchorLL = anchorWp ? anchorWp.center : null;
  const groundAnchorZoom = (() => {
    if (!scene.camera || !scene.camera.waypoints || !scene.camera.waypoints.length) return null;
    const wps = scene.camera.waypoints;
    if (wps.length === 1) return wps[0].zoom;
    const m = String(scene.scene.length || '').match(/^(?:(\d+):)?(\d{2}):(\d{2}):(\d{2})$/);
    const endSec = m
      ? ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) + Number(m[4]) / 24
      : wps[wps.length - 1].at;
    if (!(endSec > 0)) return wps[0].zoom;
    const N = 256;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += P.cameraAt(scene.camera, (endSec * i) / (N - 1)).zoom;
    return sum / N;
  })();

  // ---------------- frame driver (deterministic from t = frame/24) ----------
  // half-framing slide entry/exit (rounds 9 + 11, Ben): the whole map strip
  // slides in from its transparent edge at scene start (or scene.slideWindow
  // start) and slides back out at slideWindow[1] (defaults: in at 0, no out).
  // SLIDE_FRAMES each way, smoothstep, deterministic from t = frame/24.
  // Divider rides the strip (all children of one wrapper).
  const SLIDE_FRAMES = 16; // ~0.67s at 24fps, smoothstep
  const smooth01 = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
  const slideWin = scene.slideWindow || null; // [inStart, outStart] seconds (out optional)
  const slideOffPx = (s) => {
    if (!(HALF || HALF_RIGHT || HALF_BOTTOM)) return 0;
    const amp = (HALF || HALF_RIGHT) ? HALF_W : HALF_B_H; // half enters from the left, half-right from the right, half-bottom from below
    const inStart = slideWin ? slideWin[0] : 0;
    const inP = smooth01((s - inStart) * FPS / SLIDE_FRAMES);
    if (slideWin && slideWin.length === 2) {
      const outStart = slideWin[1];
      if (s >= outStart) {
        const outP = smooth01((s - outStart) * FPS / SLIDE_FRAMES);
        // reverse: back toward the transparent edge — half exits LEFT (entry
        // offset is negative), half-bottom exits DOWN, half-right exits RIGHT
        // (leander-07 fix: the unsigned return slid the half strip right,
        // parking it fully visible on the frame's right half)
        return (HALF ? -1 : 1) * amp * outP;
      }
    }
    return (HALF || HALF_RIGHT) ? (HALF ? -1 : 1) * HALF_W * (1 - inP) : HALF_B_H * (1 - inP);
  };
  window.__frame = (frame) => {
    const s = frame / FPS; // seconds

    // half-framing slide in/out (rounds 9 + 11): strip + divider glide from/
    // back to the transparent edge, smoothstep over SLIDE_FRAMES each way.
    // slideOffset is axis-agnostic (translate along the split axis).
    const off = slideOffPx(s);
    slideWrap.style.transform = (HALF || HALF_RIGHT) ? `translateX(${off}px)` : `translateY(${off}px)`;

    // camera: eased waypoints → jumpTo (never MapLibre animation APIs)
    if (scene.camera && scene.camera.waypoints && scene.camera.waypoints.length) {
      const cam = P.cameraAt(scene.camera, s);
      map.jumpTo({
        center: cam.center, zoom: cam.zoom,
        bearing: cam.bearing || 0, pitch: cam.pitch || 0,
      });
    }

    // exclusion alphas + resolved geometry (inline or shared shape)
    for (const ex of scene.exclusions || []) {
      if (ex.resolvedCoords === undefined) {
        const geom = typeof ex.shape === 'string' ? shapes[ex.shape] : ex.shape;
        if (!geom) throw new Error(`exclusion "${ex.id}": unresolvable shape`);
        ex.resolvedCoords =
          geom.type === 'MultiPolygon' ? geom.coordinates.flat() : geom.coordinates;
      }
      ex.alpha = P.exclusionAlpha(ex.entry, s);
    }

    // ride alphas + ride geometry (sliced once per scene, screen-space per frame)
    for (const r of scene.rides || []) {
      if (r.resolvedCoords === undefined && geo.lines[r.line]) {
        const lf = geo.lines[r.line].feature;
        r.resolvedCoords = P.sliceLineByStations(
          lf.geometry, geo.stations, r.from, r.to
        );
        r.color = geo.lines[r.line].color; // official color comes from the geo db
      }
      r.alpha = P.rideAlpha(r, s);
      r.t = s; // ride stripe flow phase (drawRide advances dashes along the path)
    }

    // pins: sit at start (or last move's to) outside move windows.
    // from-progress/to-progress moves (verdict round 21, ticket 06): resolve
    // the fractional endpoints along the line geometry once per scene —
    // scene JSON stays slug-only + progress numbers (data-is-truth)
    for (const key of Object.keys(pinMarkers)) {
      const pin = scene[key];
      // v1.7 coord moves: from-coord/to-coord resolve to private stations-map
      // keys (the same pattern as pinStartCoord) so pinPosition stays untouched
      for (const mv of pin.moves || []) {
        if (mv.__fromCoord === undefined) {
          if (mv['from-coord'] !== undefined) {
            const fcSlug = `__move${pin.moves.indexOf(mv)}from__`;
            pin.stations[fcSlug] = mv['from-coord'];
            mv.__fromCoord = mv['from-coord'];
            mv.__fromSlug = fcSlug;
          }
          if (mv['to-coord'] !== undefined) {
            const tcSlug = `__move${pin.moves.indexOf(mv)}to__`;
            pin.stations[tcSlug] = mv['to-coord'];
            mv.__toCoord = mv['to-coord'];
            mv.__toSlug = tcSlug;
          }
        }
        if (mv.__fromCoord === undefined) {
          const line = geo.lines[mv.line || (scene.rides || []).find((r) =>
            r.from === mv.from && r.to === mv.to)?.line];
          const fp = mv.overrides?.['from-progress'];
          const tp = mv.overrides?.['to-progress'];
          if (line && (fp !== undefined || tp !== undefined)) {
            const seg = P.sliceLineByStations(
              line.feature.geometry, geo.stations, mv.from, mv.to
            );
            if (seg) {
              // verdict round 22: keep the sliced station-to-station geometry
              // on the move — progress moves travel ALONG it (arc-length),
              // never chord-cut between the two resolved endpoints
              mv.__seg = seg;
              mv.__fromCoord = fp !== undefined
                ? P.pointAtProgress(seg, fp)
                : mv.__fromCoord ?? null;
              mv.__toCoord = tp !== undefined
                ? P.pointAtProgress(seg, tp)
                : mv.__toCoord ?? null;
            }
          }
          if (mv.__fromCoord === undefined) mv.__fromCoord = null;
          if (mv.__toCoord === undefined) mv.__toCoord = null;
        }
      }
      const pos = P.pinPosition(pin, s);
      if (pos.coord) pinMarkers[key].setLngLat(pos.coord);
      // pin-level window (v1.2, recipe pin-fade): faded in within, 0 outside
      const fade = pin.window !== undefined ? P.pinAlpha(pin, s) : 1;
      pinMarkers[key].setOpacity(String(fade));
    }

    // labels
    for (const lb of scene.labels || []) {
      const a = P.labelAlpha(lb, s);
      // v1.4 dot-grow / v1.10 dot-pulse (leander-intro-01): exactly one of the
      // two dot-size motions may be authored; pulse ends back at scale 1
      const g = (lb.pulse !== undefined || lb['pulse-at'] !== undefined)
        ? P.labelPulse(lb, s)
        : P.labelGrow(lb, s);
      // scale rides on the inner dot element as a CSS var — the marker
      // element's transform is owned by Marker._update (position) and must
      // not be touched
      lb.__markers.innerEl.style.setProperty('--dot-scale', String(g));
      // name marker offset follows the dot scale so text clears the ring,
      // plus a small extra clearance that grows with the scale (round-31:
      // ×1.8 halo kissed the ring; 14·(g−1) overshot — halved to 7·(g−1)).
      // v1.6: __dx/__dy (label-side/label-dy) ride the same offset.
      const base = lb.__markers.nameEl ? lb.__markers.nameEl.__baseOffset : undefined;
      if (base !== undefined) {
        const dx = lb.__markers.nameEl.__dx ?? base;
        const dy = lb.__markers.nameEl.__dy ?? 0;
        lb.__markers.name.setOffset([dx * g + 7 * (g - 1) * Math.sign(dx), dy]);
      }
      lb.__markers.dot.setOpacity(String(a));
      if (lb.__markers.name) lb.__markers.name.setOpacity(String(a));
    }

    // lineEntrances: line-layer opacity follows the line-fade recipe
    for (const le of scene.lineEntrances || []) {
      const a = P.lineEntranceAlpha(le, s);
      if (map.getLayer(le.__layerId)) {
        map.setPaintProperty(le.__layerId, 'line-opacity', 0.95 * a);
      }
    }

    // free points
    for (const pt of scene.points || []) {
      const a = P.pointAlpha(pt, s);
      pt.__dot.setOpacity(String(a));
      pt.__name.setOpacity(String(a));
    }

    drawStripesFrame(s);

    return { frame, s };
  };

  function drawStripesFrame(s) {
    const w = stripeCanvas.width, h = stripeCanvas.height;
    sctx.clearRect(0, 0, w, h);

    // paint order: exclusions → rides → outside mask (mask LAST, §6)

    // 1) exclusions (violet stripes + trimmed outlines). Stripes are
    // ground-anchored (round 25 law, hoisted round 70): drawing space = the
    // anchor camera's screen space, screen = k·drawing + t with
    // k = 2^(zoom − time-average zoom) and t = anchorScreenNow − k·(w/2, h/2)
    // — at the anchor camera the anchor point IS the canvas center, so this
    // reduces to identity at frame 0 and maps every ground point to
    // pA + k·(screen₀(p) − pA₀) afterwards. Assumes bearing/pitch 0
    // (map.project is a similarity) — all scenes to date; clip polygons keep
    // coverage regardless. Consumed by the exclusion stripes AND (round 70)
    // the ride/path dash phases.
    const ground = (() => {
      if (!groundAnchorLL) return null;
      const k = Math.pow(2, map.getZoom() - groundAnchorZoom);
      const pA = map.project(groundAnchorLL);
      return { k, tx: pA.x - k * (w / 2), ty: pA.y - k * (h / 2) };
    })();

    const excl = (scene.exclusions || []).filter((e) => e.alpha > 0);
    if (excl.length) {
      P.drawExclusions(sctx, excl, project, w, h, {
        spacing: M.excl.spacing, weight: M.excl.weight, angle: M.excl.angle,
        outline: M.excl.outline, stripe: EXCL_STRIPE, outlineColor: VIOLET,
        ground,
      });
    }

    // 2) rides (official color + alternating equal white segments along the
    // band direction, static within the window; width 8 over a 5px line,
    // white outline underlay from ride-highlight.outline-px). Dash phase
    // ground-anchored since round 70 (rides the map under zooming cameras).
    for (const r of scene.rides || []) {
      if (!r.resolvedCoords || r.alpha <= 0) continue;
      // per-ride recipe overrides win over the defaults (dash/gap/flow are
      // scene-tunable like every other recipe-backed number; previously the
      // renderer read only the registry defaults, so overrides were silently
      // ignored — found on oskar-30's wide→tight camera)
      const rp = P.paramSet('ride-highlight', r.overrides);
      P.drawRide(sctx, r, project, {
        dash: rp['dash-px'], gap: rp['gap-px'],
        lineWidth: 8,
        outlinePx: rp['outline-px'],
        flowPxPerS: rp['flow-px-per-s'],
        ground,
      });
    }

    // 2.5) walking paths (v1.12, additive): hand-authored route polylines in
    // the ride-highlight look — grey band + white dashes crawling in route
    // direction + white outline underlay; band width is the same frozen
    // renderer constant as rides. Optional tip draw-on via
    // path-highlight.draw-in. Drawn after the rides, before the outside
    // mask (ride family).
    for (const pa of scene.paths || []) {
      if (!M.path) continue;
      const st = P.pathState(pa, s);
      pa.alpha = st.alpha;
      pa.progress = st.progress;
      pa.t = s;
      if (!pa.resolvedCoords || pa.alpha <= 0) continue;
      const pp = P.paramSet('path-highlight', pa.overrides);
      P.drawPath(sctx, pa, project, {
        dash: pp['dash-px'], gap: pp['gap-px'],
        lineWidth: pp['width-px'],
        opacity: pp['opacity'],
        base: pp['base'],
        outlinePx: pp['outline-px'],
        flowPxPerS: pp['flow-px-per-s'],
        color: pa.color || PATH_COLOR,
        ground,
      });
    }

    // 3) outside-playfield mask painted LAST (verdict round 2, ticket 06:
    // stripes moved into the plum family — see PLUM_STRIPE note). Ground-
    // anchored since round 26 — same transform law as the exclusion stripes,
    // so both stripe fields ride the camera identically.
    if (playfieldRings && playfieldRings.length) {
      let ground = null;
      if (groundAnchorLL) {
        const k = Math.pow(2, map.getZoom() - groundAnchorZoom);
        const pA = map.project(groundAnchorLL);
        ground = { k, tx: pA.x - k * (w / 2), ty: pA.y - k * (h / 2) };
      }
      P.drawOutsideMask(sctx, playfieldRings, project, w, h, {
        fill: OUTSIDE_FILL, stripe: PLUM_STRIPE,
        spacing: M.outside.spacing, weight: M.outside.weight, angle: M.outside.angle,
        ground,
      });
    }

    // 3.5–3.6) segments + circles are drawn AFTER the outside mask, so they
    // are clipped to the Playfield here (round 98): their screen-space strokes
    // must not run past the playfield boundary (exclusions/rides/paths are
    // already behind the mask). One clip pass covers both loops; the divider
    // is painted after the restore and stays unclipped.
    sctx.save();
    if (playfieldRings && playfieldRings.length) P.clipToRings(sctx, playfieldRings, project);

    // 3.5) segments (violet, solid, white underlay — drawn after the mask so
    // they read over the exclusion stripes; before the divider)
    for (const sg of scene.segments || []) {
      const st = P.segmentState(sg, s);
      if (st.alpha <= 0 || st.progress <= 0) continue;
      const [a, b] = sg.coords.map((ll) => map.project(ll));
      const tipX = a.x + (b.x - a.x) * st.progress;
      const tipY = a.y + (b.y - a.y) * st.progress;
      sctx.save();
      sctx.globalAlpha = st.alpha;
      sctx.lineCap = 'round';
      sctx.lineJoin = 'round';
      sctx.beginPath();
      sctx.moveTo(a.x, a.y);
      sctx.lineTo(tipX, tipY);
      sctx.strokeStyle = SEGMENT_COLOR;
      sctx.lineWidth = 6;
      sctx.stroke();
      sctx.restore();
    }

    // 3.6) circles (v1.5): rim arcs in the exclusion violet (SEGMENT_COLOR
    // family — context circle reads as "not yet excluded", then hands over to
    // the disc exclusion at its window end), drawn after the mask.
    // Round 98: overlapping circles share one union outline (rim pieces inside
    // another circle's disc are trimmed), so no arc crosses the overlap.
    const activeCircles = [];
    for (const ci of scene.circles || []) {
      const st = P.circleState(ci, s);
      ci.alpha = st.alpha;
      ci.progress = st.progress;
      if (ci.alpha > 0 && ci.progress > 0) activeCircles.push(ci);
    }
    const projCircles = activeCircles.map((ci) => {
      const pts = ci.resolvedCoords.map(project);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { pts, bbox: [minX, minY, maxX, maxY] };
    });
    for (let i = 0; i < activeCircles.length; i++) {
      const others = projCircles.filter((_, j) => j !== i);
      P.drawCircle(sctx, activeCircles[i], project, w, h, others);
    }

    sctx.restore();

    // 4) half-framing divider (round 12: canvas-drawn, plum 10px on the
    // shared edge) — painted after the mask. Round 24 (leander-07): the
    // divider sits on the edge facing the source video — half: RIGHT edge
    // (map is the left strip), half-right: LEFT edge (map is the right
    // strip, v1.13), half-bottom: TOP edge (map is the bottom
    // strip, divider between map and video above)
    if (HALF || HALF_RIGHT || HALF_BOTTOM) {
      sctx.save();
      sctx.fillStyle = DIVIDER.color;
      if (HALF_BOTTOM) sctx.fillRect(0, 0, w, DIVIDER.thickness);
      else if (HALF_RIGHT) sctx.fillRect(0, 0, DIVIDER.thickness, h);
      else sctx.fillRect(w - DIVIDER.thickness, 0, DIVIDER.thickness, h);
      sctx.restore();
    }
  }

  // ---------------- readiness poll (never once('idle')) ----------------------
  window.__settle = () => new Promise((res) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (Date.now() >= deadline) { res(); return; }
      if (map.areTilesLoaded()) {
        setTimeout(res, 60); // 60ms settle
      } else {
        setTimeout(check, 50);
      }
    };
    setTimeout(check, 50);
  });

  window.__ready = true;
})();