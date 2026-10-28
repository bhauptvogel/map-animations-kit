# Architecture

The kit is a scene interpreter with a deterministic capture loop. This document
explains the layers, the render loop, and the invariants that keep output
reproducible.

## The five layers

```
data/geo/        WHERE things are       optional GeoJSON, slug ids, line colors
scenes/*.json    WHAT happens           declarative story, frame-exact timecodes
recipes/*.json   HOW it moves           named motion laws and defaults
style/style.json HOW it looks           basemap style and paint tokens
render/          INTERPRET              resolve, project, paint, capture, encode
```

Each layer has one owner. A scene never carries a raw color or a raw motion
number. A recipe never carries a station name. A station moves in the geo
database, not in forty scenes.

## The renderer is an interpreter

Every frame is a pure function of `t = frame / 24`:

1. Load and validate the scene.
2. Resolve all slugs against the optional geo database.
3. Ease the camera along its waypoints.
4. Project every overlay with `map.project()`.
5. Paint the stripe canvas in a fixed order.
6. Screenshot.
7. Encode.

There are no MapLibre animation APIs, no CSS transitions, no
`requestAnimationFrame` choreography, and no time-based state. This is what
makes re-renders reproducible.

## The frame loop

For each frame:

1. `map.jumpTo({ center, zoom, bearing, pitch })` to the eased camera state.
2. Poll `map.areTilesLoaded()`.
3. Wait a 60 ms settle.
4. `page.screenshot()`.
5. Move on.

Never use `once('idle')` after a same-camera `jumpTo`; it can hang. The 60 ms
settle is empirical and stable.

## Why a loopback server

The render page is served over a loopback HTTP server on an ephemeral port. The
server serves the page, the style, the scene, resolved geo data, shapes and
recipes, and it optionally serves a PMTiles extract with range requests.

This removes a class of problems: file CORS, XHR-only loading, and missing
range support. It also means the render page can use normal `fetch`.

## Determinism

The law is: **same scene + same geo data + same tiles + same renderer =
pixel-identical output**.

What buys it:

- frame-exact timecodes and `t = frame / 24`,
- one screenshot per frame,
- local PMTiles for production (hosted tiles are a convenience),
- no animation APIs,
- no CSS transitions,
- no randomness,
- deterministic intermediates (PNG frames deleted after encode).

## Framings

- `full`: 1920×1080 map.
- `half`: 806 px left strip, 42% of the frame, transparent right side.
- `half-right`: 806 px right strip, transparent left side.
- `half-bottom`: 1920×454 bottom strip, transparent top.

The map element is the strip, not the full frame. The camera center is the
strip center. The old "the strip shows the west half of the camera center"
model is wrong and causes misframed scenes.

## Paint order

The order is fixed. Scenes cannot reorder it.

```
basemap
playfield outline (optional)
static lines
exclusion stripes
ride highlights
walking paths
outside-playfield mask (optional)
segments
circles
half-framing divider
DOM overlays: pins, station labels, free points
```

Exclusions are painted before rides, even though the original prototype listed
them the other way. Segments and circles are painted after the outside mask, so
they are clipped to the playfield. The divider is painted on the canvas, not as
a DOM sibling, because a DOM bar above the WebGL map shifts the composited
layer in headless Chromium.

## Data is truth

Stations and lines are referenced by slug only. The renderer resolves names,
coordinates and official line colors from `data/geo/`. Raw coordinates appear
only in the hand-authoring exception class:

- camera centers,
- exclusion and shared shape geometry,
- pin start coordinates and coordinate moves,
- free points,
- segments,
- circle centers,
- path polylines.

The rule exists because a hand-typed station coordinate was once 720 m off.
Once the station is referenced by slug, that class of bug disappears.

## Recipes

Scenes never carry raw motion numbers. They reference recipes:

- `blink-then-stay`, `present-from-start`
- `exclusion-stripes`, `outside-playfield`
- `waypoint-glide`, `pin-glide`, `pin-fade`
- `ride-highlight`, `label-fade`, `dot-grow`, `dot-pulse`
- `line-fade`, `point-fade`, `segment-draw`, `circle-draw`
- `path-highlight`

Per-scene deviations go through an `overrides` object at the element that
carries the Window. The validator checks override keys against
`recipes/recipes.json`. The renderer imports the same file for defaults. One
source of truth, no duplicated numbers between validator and renderer.

Colors are deliberately not recipes. They are frozen style tokens.

## Validation

Two zero-dependency gates:

- `scripts/validate-geo.mjs` checks the optional geo database: RFC 7946,
  WGS84, unique ids, two-way station and line integrity, colors, winding,
  6-decimal rounding, layout.
- `scripts/validate-scene.mjs` checks the scene contract: JSON, required
  fields, timecodes, windows, slug resolution, ride endpoints, move chaining,
  shapes, recipe names, override keys, pin structure, and element-specific
  rules.

Errors block. Warnings never do. A scene that fails validation does not render;
`render.mjs` runs the same validator as a subprocess.

## Output

A render produces exactly two files per scene, flat in `./renders/` (or
`MAP_RENDER_OUT`):

```
<stem>-<variant>.mov              ProRes 4444, yuva444p10le, 16 alpha bits
render-log-<stem>-<variant>.json  per-frame capture times
```

PNG frames live in the OS temp directory and are deleted after a successful
encode. `--keep-frames` retains them for debugging.

## Environment

- Node 20 or newer.
- Playwright Chromium (`npx playwright install chromium`).
- ffmpeg with `prores_ks` support.
- The renderer uses `--enable-unsafe-swiftshader` because hardware GPU
  acceleration crashes headless Chromium on some machines.

See [`RENDER-ENV.md`](RENDER-ENV.md) for the exact versions used by the
original project.

## Authoring workflow

1. Interview the user: project, number, framing, length, beats, camera.
2. Inherit from a base scene when possible.
3. Validate.
4. Probe a frame for framing math.
5. Render through the repo `render` tool.
6. Review frames yourself.
7. Sort feedback into scene-specific and general.
8. Route general look changes through the style-tokens gate.
9. Record the change.

The `create-scene` skill in `.opencode/skills/` carries the detailed version.

## Non-goals

- Auto-computed exclusions (isochrones, routing).
- A full transit network renderer.
- Title cards, attribution, or general motion graphics.
- A visual timeline editor.
- A general-purpose animation framework.

The kit renders map clips. That constraint is the point.
