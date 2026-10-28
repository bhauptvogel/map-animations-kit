// picker.js — camera-picker browser runtime.
// Map element is EXACTLY strip-sized (zoom semantics follow the element size —
// same law as render/page/page.js): full 1920×1080, half 806×1080 left,
// half-bottom 1920×454 bottom. Overlays mirror the render look: basemap →
// playfield outline → static Lines → outside-Playfield mask (+ divider).
// Waypoints are captured from the live view and emitted as a camera.waypoints
// JSON block (6-decimal centers, per the validator's rounding rule).

'use strict';

(function () {
  const P = window.__interp;

  // ---------------- framing geometry (render/page/page.js law) ------------
  const FRAME_W = 1920, FRAME_H = 1080;
  const HALF_W = 806;   // 42% of 1920 — left strip
  const HALF_B_H = 454; // 42% of 1080 — bottom strip
  const FRAMINGS = {
    full:          { w: FRAME_W, h: FRAME_H,  left: 0, top: 0 },
    half:          { w: HALF_W,  h: FRAME_H,  left: 0, top: 0 },
    'half-right':  { w: HALF_W,  h: FRAME_H,  left: FRAME_W - HALF_W, top: 0 },
    'half-bottom': { w: FRAME_W, h: HALF_B_H, left: 0, top: FRAME_H - HALF_B_H },
  };
  const DIVIDER = { color: '#54426B', thickness: 10 };
  const VIOLET = '#623CEA';
  // outside-Playfield colors — keep in sync with render/page/page.js
  // (verdict rounds 16–20: outside fill dark neutral #44404A, muted
  // violet-grey stripes rgba(104,88,140,0.30))
  const OUTSIDE_FILL = '#44404A';
  const OUTSIDE_STRIPE = 'rgba(104,88,140,0.30)';
  const START = [13.4, 52.52];

  const mapEl = document.getElementById('map');
  const stripesEl = document.getElementById('stripes');
  const hatchEl = document.getElementById('hatch');
  const wrapEl = document.getElementById('wrap');
  const stageEl = document.getElementById('stage');
  const hudEl = document.getElementById('hud');
  const framingSel = document.getElementById('framing');
  const wpsEl = document.getElementById('wps');
  const outputEl = document.getElementById('output');
  const copyBtn = document.getElementById('copy');
  const copyHint = document.getElementById('copyHint');
  const importText = document.getElementById('importText');

  let framing = 'full';
  let wps = []; // { at (string|undefined), center, zoom, bearing, pitch }
  let easing = ''; // '' = recipe default (smoothstep), else 'smoothstep' | 'linear'
  let sceneLength = ''; // strict timecode MM:SS:FF (hours accepted on input) — emitted as scene.length
  let timeBase = 'timepin'; // 'timepin' = source video (default), 'length' = scene-relative
  let startAt = ''; // timepin mode: clip begin in the source video
  let endAt = '';   // timepin mode: clip end in the source video
  let wantSlide = true; // emit top-level slideWindow [in, out] for half framings (default on)
  let streetsChecked = true; // render law v1.18: scene.streets — street/path
  // detail layers (style.json ships them hidden, minzoom 14) shown + emitted

  // ---------------- map ----------------
  const pmtilesProtocol = new pmtiles.Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

  const map = new maplibregl.Map({
    container: 'map',
    style: '/style/style.json',
    center: START, zoom: 10.2,
    bearing: 0, pitch: 0,
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    fadeDuration: 0,
  });
  window.__map = map;

  function addLineLayers() {
    const lines = window.__GEO_LINES || {};
    for (const [slug, line] of Object.entries(lines)) {
      if (map.getSource(`line-${slug}`)) continue;
      map.addSource(`line-${slug}`, { type: 'geojson', data: line.feature });
      map.addLayer({
        id: `line-${slug}`, type: 'line', source: `line-${slug}`,
        paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': 0.95 },
      });
    }
    // overlays ride ON TOP of the Lines — load/re-raise whenever the style is
    // ready enough to accept layers (also covers style re-loads)
    loadOverlays();
  }

  map.on('style.load', () => {
    if (window.__PLAYFIELD) {
      map.addSource('playfield', { type: 'geojson', data: window.__PLAYFIELD });
      map.addLayer({
        id: 'playfield-outline', type: 'line', source: 'playfield',
        paint: { 'line-color': VIOLET, 'line-width': 2.0, 'line-dasharray': [2, 2] },
      });
    }
    addLineLayers();
    applyStreets();
  });

  // ---------------- streets & paths at close zoom (v1.18 law) --------------
  // style.json ships 'road-tertiary-minor' / 'road-service' / 'road-path'
  // hidden at minzoom 14; the render pipeline turns them on with top-level
  // scene.streets === true. The picker mirrors that exactly: checkbox ON
  // shows the detail layers AND emits `streets: true` into the output so
  // what you see is what the scene renders. (style re-loads reset them to
  // 'none' — every style.load re-applies.)
  const STREET_LAYERS = ['road-tertiary-minor', 'road-service', 'road-path'];
  function applyStreets() {
    streetsChecked = document.getElementById('streets').checked;
    for (const id of STREET_LAYERS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', streetsChecked ? 'visible' : 'none');
      }
    }
  }

  // ---------------- stripe canvas (outside-playfield mask + divider) ------
  const sctx = stripesEl.getContext('2d');
  function drawStripes() {
    const f = FRAMINGS[framing];
    const w = f.w, h = f.h;
    sctx.clearRect(0, 0, w, h);
    const rings = window.__PLAYFIELD_RINGS;
    if (rings && rings.length) {
      P.drawOutsideMask(sctx, rings, (ll) => map.project(ll), w, h, {
        fill: OUTSIDE_FILL, stripe: OUTSIDE_STRIPE,
        spacing: 14, weight: 5, angle: 45,
      });
    }
    if (framing !== 'full') {
      sctx.save();
      sctx.fillStyle = DIVIDER.color;
      if (framing === 'half-bottom') sctx.fillRect(0, 0, w, DIVIDER.thickness);
      else if (framing === 'half') sctx.fillRect(w - DIVIDER.thickness, 0, DIVIDER.thickness, h);
      else sctx.fillRect(0, 0, DIVIDER.thickness, h);
      sctx.restore();
    }
  }
  map.on('move', drawStripes);

  // ---------------- framing layout + scale-to-fit ----------------
  function layout() {
    const f = FRAMINGS[framing];
    mapEl.style.width = f.w + 'px';
    mapEl.style.height = f.h + 'px';
    mapEl.style.left = f.left + 'px';
    mapEl.style.top = f.top + 'px';
    stripesEl.style.left = f.left + 'px';
    stripesEl.style.top = f.top + 'px';
    stripesEl.width = f.w; stripesEl.height = f.h;
    stripesEl.style.width = f.w + 'px'; stripesEl.style.height = f.h + 'px';

    // scale the whole 1920×1080 frame to fit the stage viewport (the HUD
    // floats above, so give the frame a little extra left clearance)
    const pad = 24;
    const availW = Math.max(0, stageEl.clientWidth - pad * 2);
    const availH = Math.max(0, stageEl.clientHeight - pad * 2);
    const scale = Math.min(availW / FRAME_W, availH / FRAME_H, 1);
    const drawW = FRAME_W * scale, drawH = FRAME_H * scale;
    wrapEl.style.transformOrigin = 'top left';
    wrapEl.style.transform = `scale(${scale})`;
    wrapEl.style.position = 'absolute';
    wrapEl.style.left = `${pad + (availW - drawW) / 2}px`;
    wrapEl.style.top = `${pad + (availH - drawH) / 2}px`;

    // hatch: four panels covering the frame minus the strip
    hatchEl.innerHTML = '';
    const mk = (l, t, w2, h2) => {
      if (w2 <= 0 || h2 <= 0) return;
      const d = document.createElement('div');
      d.className = 'hatch-panel';
      d.style.cssText = `left:${l}px;top:${t}px;width:${w2}px;height:${h2}px;`;
      hatchEl.appendChild(d);
    };
    mk(0, 0, FRAME_W, f.top);
    mk(0, f.top, f.left, f.h);
    mk(f.left + f.w, f.top, FRAME_W - f.left - f.w, f.h);
    mk(0, f.top + f.h, FRAME_W, FRAME_H - f.top - f.h);

    map.resize();
    drawStripes();
    updateHud();
  }

  // the top bar grows/shrinks with waypoint chips — re-fit the map whenever
  // the stage's box changes (window resize alone doesn't catch this)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => layout()).observe(stageEl);
  } else {
    window.addEventListener('resize', layout);
  }

  // ---------------- HUD ----------------
  function updateHud() {
    const c = map.getCenter(), z = map.getZoom();
    const b = map.getBearing(), p = map.getPitch();
    let s = `center [${c.lng.toFixed(6)}, ${c.lat.toFixed(6)}]\nzoom ${z.toFixed(3)}`;
    if (b) s += `\nbearing ${b.toFixed(2)}`;
    if (p) s += `\npitch ${p.toFixed(2)}`;
    if (cursorLL) s += `\ncursor [${cursorLL}]`;
    hudEl.textContent = s;
    hudEl.appendChild(hudCopy);
  }
  // copy button INSIDE the HUD: copies center+zoom (agent-ready)
  const hudCopy = document.createElement('button');
  hudCopy.textContent = '⧉ Copy center+zoom';
  hudCopy.title = 'center + zoom (des aktullen Views) in die Zwischenablage kopieren';
  hudCopy.addEventListener('click', async (e) => {
    e.stopPropagation();
    const c = map.getCenter();
    const obj = { center: [Number(c.lng.toFixed(6)), Number(c.lat.toFixed(6))], zoom: Number(map.getZoom().toFixed(3)) };
    await navigator.clipboard.writeText(JSON.stringify(obj));
    hudCopy.textContent = '✓ copied';
    setTimeout(() => { hudCopy.textContent = '⧉ Copy center+zoom'; }, 1200);
  });
  map.on('move', updateHud);

  // ---------------- cursor coordinates + click-to-copy ----------------
  // hover: exact coords under the mouse in the HUD; click: copy to clipboard
  // (6-decimal, [lng, lat] — same format as camera centers / exclusion shapes)
  let cursorLL = null;
  const fmtLL = (lng, lat) => `${lng.toFixed(6)}, ${lat.toFixed(6)}`;
  map.on('mousemove', (e) => {
    cursorLL = fmtLL(e.lngLat.lng, e.lngLat.lat);
    updateHud();
  });
  map.on('mouseout', () => {
    cursorLL = null;
    updateHud();
  });
  map.on('click', async (e) => {
    const text = `[${fmtLL(e.lngLat.lng, e.lngLat.lat)}]`;
    try {
      await navigator.clipboard.writeText(text);
      setHint(`Coordinates copied: ${text}`, true);
    } catch {
      setImportHint(`Copy failed, copy manually: ${text}`, false);
    }
    setTimeout(() => setHint(''), 2500);
  });

  // ---------------- agent overlays (tools/camera-picker/overlays.json) -----
  // Agents add/remove overlays by editing overlays.json — circles (radius-m
  // around a center), lines (straight segments through hand-authored points),
  // and free points (screen-constant dot + optional label — the scene format's
  // Free-point vocabulary). The picker renders them ABOVE basemap + Lines;
  // per-overlay checkboxes toggle them, ↻ re-reads the file (server serves
  // from disk, no restart needed).
  const OVERLAYS_URL = '/tools/camera-picker/overlays.json';
  let overlayDefs = []; // file order preserved
  const overlayLayerIds = new Set();
  let overlayMarkers = new Map(); // safeId → Marker (point labels)

  function circleRing(centerLL, radiusM, steps = 128) {
    // spherical ring: offset each point by radiusM/R_earth degrees, rotated
    const R = 6371000;
    const [lng0, lat0] = centerLL;
    const latRad = (lat0 * Math.PI) / 180;
    const dLat = (radiusM / R) * (180 / Math.PI);
    const dLng = (radiusM / (R * Math.cos(latRad))) * (180 / Math.PI);
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      ring.push([lng0 + dLng * Math.cos(a), lat0 + dLat * Math.sin(a)]);
    }
    return ring;
  }

  function overlayGeo(ov) {
    if (ov.type === 'circle' && Array.isArray(ov.center) && ov['radius-m'] > 0) {
      return { type: 'Polygon', coordinates: [circleRing(ov.center, ov['radius-m'])] };
    }
    if (ov.type === 'line' && Array.isArray(ov.points) && ov.points.length >= 2) {
      return { type: 'LineString', coordinates: ov.points };
    }
    if (ov.type === 'point' && Array.isArray(ov.coord)) {
      return { type: 'Point', coordinates: ov.coord };
    }
    // freeform closed shape (agent-precomputed) — e.g. a circle intersection
    // rest area: inside 500 m from Blankenburg, outside the endspiel 500 m
    // circle and outside the library radius
    if (ov.type === 'polygon' && Array.isArray(ov.points) && ov.points.length >= 3) {
      const ring = [...ov.points];
      const [x0, y0] = ring[0];
      const last = ring[ring.length - 1];
      if (last[0] !== x0 || last[1] !== y0) ring.push([x0, y0]);
      return { type: 'Polygon', coordinates: [ring] };
    }
    return null; // unknown type / bad geometry → skipped (warned in list)
  }
  const overlaySafeId = (id) => 'ov-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

  function clearOverlayLayers() {
    for (const id of overlayLayerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    overlayLayerIds.clear();
    for (const marker of overlayMarkers.values()) marker.remove();
    overlayMarkers.clear();
  }

  function renderOverlayLayers() {
    clearOverlayLayers();
    for (const ov of overlayDefs) {
      const data = overlayGeo(ov);
      if (!data) continue;
      const srcId = overlaySafeId(ov.id) + '-src';
      const layId = overlaySafeId(ov.id);
      const vis = ov.on === false ? 'none' : 'visible';
      if (!map.getSource(srcId)) map.addSource(srcId, { type: 'geojson', data });
      if (ov.type === 'point') {
        // screen-constant dot: MapLibre circle layer (radius in px, zoom-
        // invariant by definition)
        map.addLayer({
          id: layId, type: 'circle', source: srcId,
          paint: {
            'circle-radius': ov['radius-px'] || 6,
            'circle-color': ov.color || '#000000',
            'circle-stroke-color': '#FFFFFF',
            'circle-stroke-width': 1.5,
          },
          layout: { visibility: vis },
        });
        overlayLayerIds.add(layId);
        overlayLayerIds.add(srcId);
        // optional label beside the dot — DOM marker (constant size, no glyph
        // atlas needed by the minimal style)
        if (ov.label) {
          const el = document.createElement('div');
          el.className = 'ov-label';
          el.textContent = ov.label;
          el.style.color = ov.color || '#000000';
          // kill the maplibregl .maplibregl-marker fade (opacity .2s) — the
          // toggle must be as instant as the circle layer's visibility flip
          el.style.transition = 'none';
          const marker = new maplibregl.Marker({ element: el, anchor: 'left', offset: [10, 0] })
            .setLngLat(ov.coord)
            .setOpacity(ov.on === false ? '0' : '1')
            .addTo(map);
          overlayMarkers.set(layId, marker);
        }
      } else if (ov.type === 'polygon') {
        // freeform shape: translucent fill + outline (two layers, toggled
        // together). fill-opacity: paint property, not a layout toggle.
        map.addLayer({
          id: layId, type: 'fill', source: srcId,
          paint: { 'fill-color': ov.color || '#1C3F86', 'fill-opacity': ov['fill-opacity'] || 0.15 },
          layout: { visibility: vis },
        });
        map.addLayer({
          id: layId + '-line', type: 'line', source: srcId,
          paint: {
            'line-color': ov.color || '#1C3F86',
            'line-width': ov['width-px'] || 2,
            ...(ov['dash-px'] ? { 'line-dasharray': ov['dash-px'] } : {}),
          },
          layout: { visibility: vis },
        });
        overlayLayerIds.add(layId);
        overlayLayerIds.add(layId + '-line');
        overlayLayerIds.add(srcId);
      } else {
        map.addLayer({
          id: layId, type: 'line', source: srcId,
          paint: {
            'line-color': ov.color || '#2E6BD6',
            'line-width': ov['width-px'] || 2.5,
            ...(ov['dash-px'] ? { 'line-dasharray': ov['dash-px'] } : {}),
          },
          layout: { visibility: vis },
        });
        overlayLayerIds.add(layId);
        overlayLayerIds.add(srcId);
      }
    }
    // raise all overlay layers above the static Lines (moveLayer without a
    // before-id moves to the top of the paint order)
    for (const ov of overlayDefs) {
      const layId = overlaySafeId(ov.id);
      // fill first, then outline (outline must end up above the fill); for
      // non-polygon overlays there is only the single line/circle layer
      for (const id of [layId, layId + '-line']) {
        if (map.getLayer(id)) map.moveLayer(id);
      }
    }
  }

  function renderOverlayList() {
    const list = document.getElementById('ovList');
    list.innerHTML = '';
    if (overlayDefs.length === 0) {
      const none = document.createElement('span');
      none.className = 'hint';
      none.textContent = 'keine (overlays.json)';
      list.appendChild(none);
      return;
    }
    for (const ov of overlayDefs) {
      const label = document.createElement('label');
      label.className = 'ov-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ov.on !== false;
      cb.addEventListener('change', () => {
        ov.on = cb.checked;
        const layId = overlaySafeId(ov.id);
        const vis = ov.on ? 'visible' : 'none';
        // polygon overlays carry fill (layId) + outline (layId-line) together
        for (const id of [layId, layId + '-line']) {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
        }
        const labelMarker = overlayMarkers.get(layId);
        if (labelMarker) labelMarker.setOpacity(ov.on ? '1' : '0');
      });
      const dot = document.createElement('span');
      dot.className = 'ov-dot';
      dot.style.background = ov.color || '#2E6BD6';
      label.append(cb, dot, document.createTextNode(ov.id));
      list.appendChild(label);
    }
  }

  async function loadOverlays() {
    overlayDefs = [];
    try {
      const r = await fetch(OVERLAYS_URL);
      if (r.ok) {
        const v = await r.json();
        overlayDefs = Array.isArray(v && v.overlays) ? v.overlays : [];
      }
    } catch {}
    const bad = overlayDefs.filter((ov) => !overlayGeo(ov));
    renderOverlayLayers();
    renderOverlayList();
    if (bad.length) setHint(`Overlays ignoriert (Typ/Geometrie): ${bad.map((b) => b.id).join(', ')}`, false);
  }

  // ---------------- waypoint list ----------------
  function nextAt() {
    // OUT convention (end−1s) only where the slide-out actually exists: half
    // framings with Slide in/out on. Otherwise new waypoints extend to the
    // clip end (timepin: end_at; length: previous + 2 s as before).
    const slideOut = framing !== 'full' && wantSlide;
    if (timeBase === 'timepin') {
      if (wps.length === 0) return startAt || '00:00:00';
      const endFr = tcToFrames(endAt);
      if (endFr !== null) {
        return framesToTc(slideOut ? Math.max(0, endFr - FPS) : endFr);
      }
      return startAt || '00:00:00';
    }
    if (wps.length === 0) return '00:00:00';
    const prevFr = tcToFrames(wps[wps.length - 1].at);
    if (prevFr === null) return '00:02:00';
    if (!slideOut) {
      // no slide-out: new waypoints extend to the clip end (length −1s also
      // wrong without a slide; go to the full end so the camera holds it)
      const lenFr = tcToFrames(sceneLength);
      if (lenFr !== null) return framesToTc(lenFr);
      return framesToTc(prevFr + 2 * FPS);
    }
    return framesToTc(prevFr + 2 * FPS); // +2 s, frame-exact
  }
  function fmtWP(wp) {
    // two lines so the text always fits the 232px chip (no clipping)
    const c = wp.center.map((v) => v.toFixed(6));
    let s = `center [${c[0]}, ${c[1]}]\nzoom ${wp.zoom.toFixed(3)}`;
    if (wp.bearing) s += `  bearing ${wp.bearing.toFixed(2)}`;
    if (wp.pitch) s += `  pitch ${wp.pitch.toFixed(2)}`;
    return s;
  }
  function capture() {
    const c = map.getCenter();
    wps.push({
      at: nextAt(),
      center: [Number(c.lng.toFixed(6)), Number(c.lat.toFixed(6))],
      zoom: Number(map.getZoom().toFixed(3)),
      bearing: Number(map.getBearing().toFixed(2)),
      pitch: Number(map.getPitch().toFixed(2)),
    });
    renderWps();
  }
  function jumpTo(i) {
    const wp = wps[i];
    map.jumpTo({ center: wp.center, zoom: wp.zoom, bearing: wp.bearing || 0, pitch: wp.pitch || 0 });
    markCurrent(i);
  }
  function updateFromView(i) {
    const c = map.getCenter();
    wps[i].center = [Number(c.lng.toFixed(6)), Number(c.lat.toFixed(6))];
    wps[i].zoom = Number(map.getZoom().toFixed(3));
    wps[i].bearing = Number(map.getBearing().toFixed(2));
    wps[i].pitch = Number(map.getPitch().toFixed(2));
    renderWps();
  }
  function markCurrent(i) {
    for (const el of wpsEl.querySelectorAll('.wp')) el.classList.remove('current');
    const el = wpsEl.querySelector(`.wp[data-i="${i}"]`);
    if (el) el.classList.add('current');
  }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= wps.length) return;
    [wps[i], wps[j]] = [wps[j], wps[i]];
    renderWps();
  }
  function renderWps() {
    wpsEl.innerHTML = '';
    wps.forEach((wp, i) => {
      const d = document.createElement('div');
      d.className = 'wp';
      d.dataset.i = i;
      const head = document.createElement('div');
      head.className = 'wp-head';
      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = i === 0 ? 'IN' : (i === wps.length - 1 && wps.length > 1) ? 'OUT' : `#${i}`;
      const at = document.createElement('input');
      at.type = 'text'; at.className = 'at'; at.value = wp.at || '';
      at.title = 'Timecode MM:SS:FF (FF = frames 00-23, 24 fps). Digits format live: 050604 -> 05:06:04. Leave empty to let the agent schedule it';
      at.placeholder = 'MM:SS:FF';
      at.addEventListener('input', () => {
        // live chunks while typing — only unambiguous runs (≥ 6 digits);
        // shorter runs stay raw until commit (commitTCInput picks the law)
        const v = at.value.trim();
        if (/^[\d:]+$/.test(v)) {
          const digitCount = v.replace(/:/g, '').length;
          if (digitCount >= 6) liveFormatTC(at);
        }
      });
      at.addEventListener('blur', () => {
        if (/^\d+$/.test(at.value.trim()) && at.value.trim().length <= 6) {
          at.value = rightPadDigits(at.value.trim());
        } else {
          at.value = normalizeTCInput(at.value);
        }
      });
      at.addEventListener('change', () => {
        commitTCInput(at);
        wp.at = at.value.trim();
        updateOutput();
      });
      const actions = document.createElement('div');
      actions.className = 'wp-actions';
      const mkBtn = (label, title, fn, dis) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        if (dis) b.disabled = true;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mkBtn('⤴', 'Jump to this waypoint', () => jumpTo(i)),
        mkBtn('↺', 'Overwrite from current view', () => updateFromView(i)),
        mkBtn('✕', 'Delete waypoint', () => { wps.splice(i, 1); renderWps(); }),
      );
      const actions2 = document.createElement('div');
      actions2.className = 'wp-actions2';
      const copyWp = async () => {
        // single-waypoint copy: same shape as in the emitted output (at
        // translated in timepin mode; empty → 00:00:00 for the first)
        const startFr = timeBase === 'timepin' ? tcToFrames(startAt) : null;
        const obj = wpJSON(wp, i, startFr);
        await navigator.clipboard.writeText(JSON.stringify(obj));
        setHint(`Waypoint ${i === 0 ? 'IN' : `#${i}`} copied ✓`, true);
        setTimeout(() => setHint(''), 1500);
      };
      actions2.append(
        mkBtn('⧉ Copy', 'Copy this waypoint as JSON', copyWp),
        mkBtn('↑ Nach oben', 'Nach oben', () => move(i, -1), i === 0),
        mkBtn('↓ Nach unten', 'Nach unten', () => move(i, +1), i === wps.length - 1),
      );
      head.append(idx, at, actions);
      const coords = document.createElement('div');
      coords.className = 'coords';
      coords.textContent = fmtWP(wp);
      d.append(head, actions2, coords);
      wpsEl.appendChild(d);
    });
    // rail count + auto-scroll to the newest chip
    document.getElementById('wpsCount').textContent = `Waypoints: ${wps.length}`;
    const last = wpsEl.lastElementChild;
    if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    copyBtn.disabled = wps.length === 0;
    updateOutput();
  }

  // ---------------- output ----------------
  // emitted waypoint shape — shared by updateOutput and the per-chip copy
  function wpJSON(wp, i, startFr) {
    const o = { center: wp.center, zoom: wp.zoom };
    if (wp.bearing) o.bearing = wp.bearing;
    if (wp.pitch) o.pitch = wp.pitch;
    let atFr = tcToFrames(wp.at);
    if (atFr === null) atFr = i === 0 ? 0 : tcToFrames(wps[i - 1].at ?? '00:00:00');
    if (atFr === null) atFr = 0;
    if (startFr !== null) {
      atFr = Math.max(0, atFr - startFr);
    }
    return { at: framesToTc(atFr), ...o };
  }
  function updateOutput() {
    if (wps.length === 0) { outputEl.value = ''; updateLengthHint(); return; }
    // timepin mode: translate source `at` into scene time, frame-exact
    // (at_scene = at_source − start_at); start/end pins must be valid.
    let startFr = null;
    let endFr = null;
    if (timeBase === 'timepin') {
      startFr = tcToFrames(startAt);
      endFr = tcToFrames(endAt);
      if (startFr === null || endFr === null || endFr <= startFr) {
        outputEl.value = '';
        updateLengthHint('Timepins: start_at/end_at müssen gültige Timecodes sein, end_at > start_at.');
        return;
      }
    }
    let warned = false;
    const out = wps.map((wp, i) => {
      const o = wpJSON(wp, i, startFr);
      if (startFr !== null) {
        const atFr = tcToFrames(wp.at);
        if (atFr !== null && atFr < startFr) warned = true;
      }
      return o;
    });
    if (timeBase === 'timepin') {
      // first waypoint should land on 00:00:00 after translation (scene law);
      // if the user set it later, keep the value but flag it in the hint
      if (!warned && tcToFrames(wps[0].at || '00:00:00') !== startFr) warned = true;
    }
    const camera = { waypoints: out };
    // easing choice rides camera.overrides (waypoint-glide recipe) — emitted
    // only when ≠ recipe default, so the block stays minimal
    if (easing && easing !== 'smoothstep') camera.overrides = { easing };
    // scene.length: length mode → the Länge input; timepin mode → end−start,
    // frame-exact. Lives under scene{} per the scene-format top-level schema.
    let length = null;
    if (timeBase === 'length') {
      length = sceneLength || null;
    } else {
      length = framesToTc(endFr - startFr);
    }
    // slideWindow (checkbox): the half-framing slide in/out — top-level
    // [inStart, outStart] in SCENE time (renderer slides over 16 frames,
    // smoothstep; page.js slideOffPx). Emitted only for half framings (full
    // ignores it). in = clip start; out = end − 1 s (exit finishes before the
    // clip ends. Timepin mode translates out via -start_at.
    let slideWindow = null;
    if (wantSlide && framing !== 'full' && length) {
      const lenFr = timeBase === 'timepin' ? endFr - startFr : tcToFrames(sceneLength);
      if (lenFr !== null && lenFr > FPS) {
        const inFr = 0;
        const outFr = Math.max(0, lenFr - FPS);
        slideWindow = [framesToTc(inFr), framesToTc(outFr)];
      }
    }
    updateLengthHint(warned
      ? 'Note: a waypoint is before start_at (or the first waypoint is not start_at). Check the translated output.'
      : null);
    // scene{} block: length (when set) + framing — the agent gets the full
    // scene{} shell and must not guess the framing (it also decides whether
    // slideWindow applies at all)
    const outObj = { camera };
    outObj.scene = { framing };
    if (length) outObj.scene.length = length;
    if (slideWindow) outObj.slideWindow = slideWindow;
    // v1.18: street/path detail — emitted iff visible (render law: top-level
    // `streets: true`; scenes without it stay unchanged)
    if (streetsChecked) outObj.streets = true;
    outputEl.value = JSON.stringify(outObj, null, 2);
  }

  // ---------------- timecode law (scene-format §Time model) ------------------
  // (HH:)MM:SS:FF at 24 fps — 3-part MM:SS:FF while < 10 min, 4-part
  // HH:MM:SS:FF from 10 min up (a bare `10:14:00` would read as H:MM:SS).
  // Frames FF ∈ 00–23, seconds SS ∈ 00–59. All math is integer frames —
  // never float seconds — frame-exact translation.
  const FPS = 24;
  const TC_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}):(\d{2})$/;
  function tcToFrames(tc) {
    const m = TC_RE.exec(tc || '');
    if (!m) return null;
    const [, h, mm, ss, ff] = m;
    const s = +ss, f = +ff;
    if (s > 59 || f > 23) return null;
    return ((+(h || 0)) * 3600 + (+mm) * 60 + s) * FPS + f;
  }
  function framesToTc(fr) {
    const p2 = (n) => String(n).padStart(2, '0');
    // output law: 3-part MM:SS:FF while unambiguous (< 10 min), 4-part
    // HH:MM:SS:FF from 10 min up — a bare `10:14:00` would read as H:MM:SS.
    // Minutes never roll into a bare hours-less >59 form (validator: mm ≤ 59).
    const totalSec = Math.floor(fr / FPS);
    if (totalSec >= 600) {
      const h = Math.floor(totalSec / 3600);
      const mm = Math.floor(totalSec / 60) % 60;
      const ss = totalSec % 60;
      return `${p2(h)}:${p2(mm)}:${p2(ss)}:${p2(fr % FPS)}`;
    }
    const mm = Math.floor(totalSec / 60);
    return `${p2(mm)}:${p2(totalSec % 60)}:${p2(fr % FPS)}`;
  }
  // parseAt: scene-law seconds (3-part = MM:SS:FF) — used by the scrub preview
  function parseAt(tc) {
    const fr = tcToFrames(tc);
    return fr === null ? null : fr / FPS;
  }
  // digit shorthand: bare digits become a timecode while typing — left-to-
  // right chunking, 2 digits per group: 050604 → 05:06:04, 8 digits →
  // HH:MM:SS:FF (00101400 → 00:10:14:00). 7 digits read H MM SS FF. Ranges
  // are NOT validated here (the change handlers + tcToFrames do that).
  function chunkDigits(d) {
    if (d.length > 6) {
      const hLen = d.length - 6; // 1 or 2 leading digits = hours
      return `${d.slice(0, hLen)}:${d.slice(hLen, hLen + 2)}:${d.slice(hLen + 2, hLen + 4)}:${d.slice(hLen + 4)}`;
    }
    const groups = [];
    for (let i = 0; i < d.length; i += 2) groups.push(d.slice(i, i + 2));
    return groups.join(':');
  }
  // right-pad a short digit run into MM:SS:FF (15 → 00:00:15, "15 frames")
  function rightPadDigits(v) {
    const d = v.padStart(6, '0');
    return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}`;
  }
  function normalizeTCInput(raw) {
    const v = (raw || '').trim();
    if (!/^\d+$/.test(v) || v.length > 8) return v; // untouched: already TC or invalid
    // 7–8 digits carry explicit hours, left-read; shorter runs are handled by
    // commitTCInput (left-read preferred, right-pad fallback)
    return chunkDigits(v);
  }
  // live formatting on every keystroke — driven by the digits only, so
  // reformats stay idempotent while typing. Colons the user typed manually
  // are honored by reading digits left-to-right (identical law), so mixed
  // editing stays predictable; non-digit junk (e.g. '15 seconds') leaves
  // the digits unchanged → formatting no-ops.
  function liveFormatTC(el) {
    // only own the two shapes this law produces: pure digits or digits+colons
    if (!/^[\d:]+$/.test(el.value)) return;
    const digits = el.value.replace(/\D/g, '').slice(0, 8);
    if (!digits) return;
    const formatted = chunkDigits(digits);
    if (formatted !== el.value) {
      el.value = formatted;
      el.setSelectionRange(formatted.length, formatted.length);
    }
  }
  // commit law: make a bare digit run parseable. Preferred: left-read chunks
  // (050604 → 05:06:04, the live-format law). If that doesn't parse (odd
  // digit counts like 104 → '10:4'), fall back to right-padding (00:01:04);
  // if neither parses, hand the raw value to the change-handler validation.
  function commitTCInput(el) {
    const v = (el.value || '').trim();
    if (/^\d+$/.test(v) && v.length <= 8) {
      const left = chunkDigits(v);
      el.value = tcToFrames(left) !== null ? left
        : (tcToFrames(rightPadDigits(v)) !== null ? rightPadDigits(v) : v);
      return;
    }
    el.value = normalizeTCInput(v);
  }
  const scrubEl = document.getElementById('scrub');
  const scrubHint = document.getElementById('scrubHint');
  let scrubbing = false;
  function scrubCamera() {
    // build the interpreter's camera object: seconds + chosen easing.
    // timepin mode: preview the translated scene span [start_at, end_at].
    let wpsSec = wps.map((wp) => ({ at: parseAt(wp.at), center: wp.center, zoom: wp.zoom, bearing: wp.bearing, pitch: wp.pitch }));
    if (wpsSec.some((wp) => wp.at === null)) {
      scrubEl.disabled = true;
      scrubHint.textContent = 'needs `at` on every waypoint';
      return null;
    }
    scrubEl.disabled = false;
    if (timeBase === 'timepin') {
      const s0 = parseAt(startAt), s1 = parseAt(endAt);
      if (s0 === null || s1 === null || !(s1 > s0)) {
        scrubHint.textContent = 'needs valid timepins: end_at > start_at.';
        return null;
      }
      scrubHint.textContent = 'over the translated scene time [start_at … end_at]';
      return { waypoints: wpsSec.map((wp) => ({ ...wp, at: wp.at - s0 })), easingName: easing || 'smoothstep', t0: s0, t1: s1 };
    }
    scrubHint.textContent = '';
    return {
      waypoints: wpsSec,
      easingName: easing || 'smoothstep',
      t0: wpsSec[0].at,
      t1: wpsSec[wpsSec.length - 1].at,
    };
  }
  function applyScrub(t01) {
    const cam = scrubCamera();
    if (!cam || wps.length < 2) return;
    const { t0, t1 } = cam;
    if (!(t1 > t0)) { scrubHint.textContent = 'Erster und letzter `at` sind gleich — keine Bewegung vorzeigbar.'; return; }
    const s = t0 + (t1 - t0) * t01;
    const c = P.cameraAt(cam, s);
    map.jumpTo({ center: c.center, zoom: c.zoom, bearing: c.bearing || 0, pitch: c.pitch || 0 });
  }
  scrubEl.addEventListener('input', () => applyScrub(Number(scrubEl.value) / 1000));
  document.getElementById('previewIn').addEventListener('click', () => { if (wps.length) jumpTo(0); });
  document.getElementById('previewOut').addEventListener('click', () => { if (wps.length) jumpTo(wps.length - 1); });

  // ---------------- import ----------------
  // copyHint (next to the Copy button) doubles as the feedback line for
  // import results — there is no separate import hint anymore
  function setHint(msg, flash) {
    copyHint.textContent = msg;
    copyHint.className = flash ? 'hint flash' : 'hint';
  }
  function setImportHint(msg, flash) {
    setHint(msg, flash);
  }
  function importFromText(raw, sourceLabel) {
    raw = (raw || '').trim();
    if (!raw) {
      setImportHint('Paste JSON first, then import.');
      return;
    }
    let v;
    try { v = JSON.parse(raw); } catch (e) {
      setImportHint(`Import error: ${e.message}`);
      return;
    }
    // whole-scene paste: take framing too, so the viewport matches the scene
    const sceneFraming = v && v.scene && v.scene.framing;
    const arr = Array.isArray(v) ? v : v && v.camera && v.camera.waypoints;
    if (!Array.isArray(arr) || arr.length === 0) {
      setImportHint('Import error: no waypoints array found');
      return;
    }
    if (sceneFraming && FRAMINGS[sceneFraming]) {
      framing = sceneFraming;
      framingSel.value = framing;
      layout();
      updateSlideVisibility();
    }
    wps = arr.map((wp) => ({
      at: typeof wp.at === 'string' ? wp.at : undefined,
      center: wp.center,
      zoom: wp.zoom,
      bearing: wp.bearing || 0,
      pitch: wp.pitch || 0,
    }));
    // camera.overrides.easing → easing select (absent = recipe default)
    const importedEasing = v && v.camera && v.camera.overrides && v.camera.overrides.easing;
    easing = typeof importedEasing === 'string' ? importedEasing : '';
    document.getElementById('easing').value = easing;
    // whole-scene paste: take over scene.length too (validate strictly first).
    // Imported scenes are scene-relative → switch to length mode (timepins are
    // a capture-side notation, not scene data).
    timeBase = 'length';
    timeBaseSel.value = 'length';
    renderTimeCol();
    startAt = ''; endAt = '';
    startAtEl.value = ''; endAtEl.value = '';
    updateLengthHint();
    // whole-scene imports mirror the scene's slideWindow into the checkbox
    // (in is always clip start). Camera-only imports leave the slide
    // preference untouched — the pasted waypoints carry no slide information.
    const isWholeScene = !!(v && v.scene);
    const importedSlide = v && v.slideWindow;
    if (isWholeScene) {
      wantSlide = Array.isArray(importedSlide) && importedSlide.length === 2;
      for (const cb of slideChecks) cb.checked = wantSlide;
      // whole-scene imports mirror the scene's top-level `streets` too —
      // absent (the existing-scene default) means uncheck, so imported
      // scenes always render exactly the way they render in production
      document.getElementById('streets').checked = v.streets === true;
      applyStreets();
    }
    const importedLength = v && v.scene && v.scene.length;
    if (typeof importedLength === 'string' && parseAt(importedLength) !== null) {
      sceneLength = importedLength;
      document.getElementById('length').value = sceneLength;
    }
    scrubEl.value = '0';
    setImportHint(`${wps.length} waypoint(s) imported${sceneFraming ? `, framing ${sceneFraming}` : ''}${sourceLabel ? ` — ${sourceLabel}` : ''} ✓`, true);
    renderWps();
    jumpTo(0);
  }
  function doImport() { importFromText(importText.value); }
  // text import is folded away by default — toggle via the "Text ▾" button
  const importTextWrap = document.getElementById('importTextWrap');
  document.getElementById('import').addEventListener('click', () => {
    const show = importTextWrap.style.display === 'none';
    importTextWrap.style.display = show ? '' : 'none';
  });

  // ---------------- wire up ----------------
  // the length input row lives permanently in the Zeit column (hidden in
  // timepin mode) — uniform layout in both modes; declared before use below
  const lengthEl = document.getElementById('length');
  const lengthFrow = lengthEl.closest('.frow');
  document.getElementById('capture').addEventListener('click', capture);
  lengthEl.addEventListener('input', () => liveFormatTC(lengthEl));
  lengthEl.addEventListener('change', () => {
    commitTCInput(lengthEl);
    const val = lengthEl.value.trim();
    if (val && parseAt(val) === null) {
      setHint('Length: invalid timecode. Format MM:SS:FF (FF = frames), e.g. 00:15:00');
      return;
    }
    sceneLength = val;
    updateOutput();
  });
  // Zeitbasis: length (scene-relative) vs timepin (source video). The pin
  // column header + pin row swap to the length row inside the same column.
  const timeBaseSel = document.getElementById('timeBase');
  const pinCol = document.getElementById('pinCol');
  const pinRow = document.getElementById('pinRow');
  const pinHint = document.getElementById('pinHint');
  const startAtEl = document.getElementById('startAt');
  const endAtEl = document.getElementById('endAt');
  pinCol.insertBefore(lengthFrow, pinHint);
  function updateLengthHint(msg) {
    if (msg) { pinHint.textContent = msg; pinHint.style.display = ''; return; }
    pinHint.style.display = timeBase === 'timepin' ? '' : 'none';
    if (timeBase === 'timepin') {
      pinHint.textContent = 'Waypoint `at` is source time. Output subtracts start_at frame-exactly; length = end_at - start_at.';
    }
  }
  function renderTimeCol() {
    // uniform column structure in BOTH modes: header, one input row, one
    // hint — only the input row's contents swap. No DOM moving, no jumps.
    pinCol.querySelector('.bar-head').textContent =
      timeBase === 'timepin' ? 'Time — source timepins' : 'Time — length (scene time)';
    pinRow.style.display = timeBase === 'timepin' ? '' : 'none';
    lengthFrow.style.display = timeBase === 'length' ? '' : 'none';
    updateLengthHint();
  }
  timeBaseSel.addEventListener('change', () => {
    timeBase = timeBaseSel.value;
    renderTimeCol();
    updateOutput();
  });
  for (const [el, key] of [[startAtEl, 'startAt'], [endAtEl, 'endAt']]) {
    el.addEventListener('input', () => liveFormatTC(el));
    el.addEventListener('blur', () => commitTCInput(el));
    el.addEventListener('change', () => {
      commitTCInput(el);
      const val = el.value.trim();
      if (val && tcToFrames(val) === null) {
        setHint(`${el.id === 'startAt' ? 'start_at' : 'end_at'}: kein gültiger Timecode — Format MM:SS:FF (FF = Frames)`);
        return;
      }
      if (key === 'startAt') startAt = val; else endAt = val;
      updateOutput();
    });
  }
  // slide in/out checkbox — two inputs (one per mode row), kept in sync
  const slideChecks = [...document.querySelectorAll('#slideWindow')];
  for (const cb of slideChecks) {
    cb.addEventListener('change', () => {
      wantSlide = cb.checked;
      for (const other of slideChecks) if (other !== cb) other.checked = wantSlide;
      updateOutput();
    });
  }
  document.getElementById('easing').addEventListener('change', (e) => {
    easing = e.target.value;
    updateOutput();
  });
  // streets toggle: layer visibility + emission in one value (applyStreets
  // re-applies on every style.load — style re-loads reset visibility to 'none')
  document.getElementById('streets').addEventListener('change', () => {
    applyStreets();
    updateOutput();
  });
  document.getElementById('importPaste').addEventListener('click', doImport);
  // file import: picker button + drag-and-drop onto the whole import section
  // (works whether or not the text area is unfolded)
  const importArea = document.getElementById('importArea');
  const importFileBtn = document.getElementById('importFile');
  const importFileInput = document.getElementById('importFileInput');
  importFileBtn.addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files && importFileInput.files[0];
    if (!file) return;
    const text = await file.text();
    importText.value = text;
    importFromText(text, file.name);
    importFileInput.value = '';
  });
  importArea.addEventListener('dragover', (e) => e.preventDefault());
  importArea.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      file.text().then((text) => {
        importText.value = text;
        importFromText(text, file.name);
      });
    }
  });
  document.getElementById('clear').addEventListener('click', () => {
    wps = []; renderWps();
    sceneLength = ''; lengthEl.value = '';
    startAt = ''; endAt = '';
    startAtEl.value = ''; endAtEl.value = '';
    // slide checkbox state is a framing preference, not waypoint data — keep it
    // (same for the streets checkbox: a session view preference)
    setHint('');
  });
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(outputEl.value);
    setHint('Kopiert ✓', true);
    setTimeout(() => setHint(''), 1500);
  });
  // slide in/out is a half-framing-only control: hidden (and never emitted)
  // for full framing
  function updateSlideVisibility() {
    const half = framing !== 'full';
    for (const el of document.querySelectorAll('.slide-check')) {
      el.classList.toggle('half-on', half);
    }
  }
  framingSel.addEventListener('change', () => {
    framing = framingSel.value;
    layout();
    updateSlideVisibility();
    updateOutput();
  });
  document.getElementById('fit').addEventListener('click', layout);
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'c' || e.key === 'C') capture();
  });

  // ---------------- boot ----------------
  // geo lines + playfield rings arrive as window.__GEO_LINES / window.__PLAYFIELD_RINGS
  // (injected by the server); layout once the map element has its strip size.
  updateSlideVisibility();
  layout();
  map.on('load', () => { addLineLayers(); layout(); drawStripes(); });
  document.getElementById('ovReload').addEventListener('click', loadOverlays);
})();