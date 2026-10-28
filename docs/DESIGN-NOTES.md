# Design notes

These are the laws and traps earned by the production project this kit was
extracted from. Read this before changing the renderer.

## Why the architecture looks like this

The expensive part of a map-animation pipeline is not drawing a line. It is
keeping the look consistent across many clips while the story changes every
time. The kit separates the story from the look and from the data:

- **Scenes** describe what happens.
- **Recipes** describe how it moves.
- **The geo database** describes where it is.
- **The style** describes how it looks.
- **The renderer** only interprets.

That separation is why the original project survived 120 scenes and 21
additive format versions without the look drifting.

## Renderer laws

### Determinism and capture

- Drive everything from `t = frame / 24`. No MapLibre animation APIs, no CSS
  transitions, no randomness.
- `map.jumpTo`, then poll `map.areTilesLoaded()`, then wait a 60 ms settle,
  then screenshot. Never use `once('idle')` after a same-camera `jumpTo`.
- Use local PMTiles for production. Hosted tiles are convenient but can drift.
- Delete PNG frames after a successful encode. They are deterministic
  intermediates.

### MapLibre and DOM overlays

- Every DOM marker uses `Marker.setSubpixelPositioning(true)`. Without it,
  `moveend` rounds the marker to integer pixels each frame while the basemap
  projects sub-pixel smoothly, so pins and labels flicker on camera moves.
- Drive marker fades with `marker.setOpacity()`, never CSS. MapLibre resets the
  marker root element's opacity.
- Draw the half-framing divider on the stripe canvas, not as a DOM sibling. A
  DOM bar above the WebGL map shifts the composited layer in headless
  Chromium.
- Pins and labels do not scale with zoom. Check both zoom extremes.

### Stripes and geometry

- Stripes are always a 2D canvas overlay projected per frame. Never
  `fill-pattern`: it anchors per vector tile and seams.
- Anchor both stripe fields to the Web-Mercator ground plane. A screen-space
  anchor slides against the basemap during zooms.
- Use the scene's time-average zoom as the stripe scale reference. A global
  anchor makes tightly zoomed scenes inherit another clip's density.
- Never `ctx.clip()` in the exclusion passes. Skia's clip-mask rasterizer leaks
  fragments on huge offscreen paths. Use a fill mask plus `destination-in`.
- Fill and erase one exclusion per `nonzero` pass. Accumulating different
  exclusions into one path can cancel winding in overlaps and hole the union.
- Generated exterior rings are counterclockwise (RFC 7946). A clockwise ring
  can cancel its neighbors.
- Exclusions with an identical entry (recipe, window, overrides) are one union
  group. Strip them once; subtract only non-group exclusions.
- Project each exclusion's rings once per call and bbox-test before the
  per-piece outline ray cast. Re-projecting every ring for every test piece is
  slow at region scale.
- Size stripe segments from the farthest corner distance to the drawing
  origin, not the viewport diagonal. Otherwise a far corner is unstriped at
  big zoom deltas.

### Rides, paths, and dashes

- Anchor dash phases to the ground plane. A dash phase anchored to the
  projected start point sweeps under a zooming camera and reads backwards.
- A walking trace is one path object plus `append`. Two stitched path objects
  restart the dash phase and show a seam.
- A path that must not read as a ride uses `base: false`, a thin `width-px`, no
  outline, a dark color, and `flow-px-per-s: 0`.
- Put `line` on every progress move. Without it, the renderer falls back to a
  straight chord across a curve.
- Slice rides by the line's own station order. A reversed endpoint polarity
  draws a doubled scribble.

### Framing and camera math

- In half framings the map element is the strip. The camera center is the
  strip center. The old "west half of the camera center" model is wrong.
- Use 512 px tile math: meters per pixel =
  `40,075,016 × cos(lat) / (512 × 2^zoom)`. 256 px math gives a fit exactly one
  zoom level too tight.
- Per-segment smoothstep rests at every waypoint. Use
  `camera.overrides.path: "spline"` for a continuous pass.
- Fit the binding content at the most-spread waypoint's zoom, and check both
  zoom extremes.
- The half strip is 42% of the frame, not 50%.

### Output and alpha

- ProRes 4444 with `yuva444p10le` and `-alpha_bits 16`.
- `omitBackground: true` and a transparent page for half framings.
- If an element must persist to the last frame, set `fade-out: 0`. A window
  ending at the scene length otherwise dissolves the element over the last
  fade.
- Fades are clamped to half the window. Short windows never pop.

### Data

- Slug-only station and line references. Hand-typed coordinates drift. One
  hand-typed station was 720 m off.
- Generated discs must be counterclockwise. A clockwise disc cancels neighbors
  under `nonzero`.
- Freeze the data before a series. A rebuild can silently lose hand curation.
- Verify line endpoints against the station list. A route relation can be
  truncated at the wrong end.

## Authoring traps

- A one-element `slideWindow` slides in and never exits. Add the second
  element if you want an exit.
- A new timecode field must be converted to seconds in `deep-times.mjs`.
  Missing conversion produces `NaN` and invisible elements.
- A progress move without `line` cuts a chord. A coordinate move with a bend
  must be split into chained moves.
- A long right-side label can run past the divider. Use `label-side: "left"`,
  `label-dy`, or a smaller `label-scale`.
- A label dot can overlay a carried dot wall and read as two dots. Drop the
  wall entry or grow the label dot.
- A free point is the right tool for a scene-local position. Do not move a
  station in the scene; the geo database is truth.
- A scene that inherits a pin photo can inherit the wrong identity. Check the
  photo convention per project.

## Workflow that worked

1. Interview before writing JSON: project, number, framing, length, beats,
   camera.
2. Inherit from a base scene and state what you carried.
3. Validate before rendering.
4. Probe a frame for framing math and label widths.
5. Render through the repo tool, not a raw shell command.
6. Review real frames, not JSON.
7. Sort feedback into scene-specific and general before editing.
8. Route general look changes through the style-token gate.
9. Record the change.

## Decisions worth keeping

- Declarative scenes plus named recipes.
- Data is truth; slug-only references.
- Additive-only exclusions.
- Two pins maximum.
- No rendered attribution or title cards.
- No free-rendered text beyond station names, renderer constants, and
  `points[].text`.
- Local tiles for determinism.
- Output outside the repo, or in a gitignored `renders/`.
- No preview proxy. The master and the log are the artifacts.
- Frame-exact timecodes.
- One scene, one framing.
- Half means 42%, strip-centered.
- Frozen look tokens with a gate.
- Zero-dependency validators.
- The renderer owns no choreography.

## If you build this again

1. `git init` on day one.
2. Write the domain glossary before the code.
3. Write the scene format and the recipe registry.
4. Write the validators before the renderer.
5. Build the geo database with a validator and a provenance table.
6. Build the local tile extract and run a parity gate.
7. Build the renderer as an interpreter.
8. Prove determinism cross-run on a stub scene.
9. Build the camera picker early.
10. Record the environment versions.
11. Freeze the look tokens only after a real verdict.
12. Write the create-scene skill after 2-3 real scenes, not before.
13. Write the style-token gate before the first general feedback round.
14. Keep a verdict log from the first render.
15. Generate the scene/master manifest after every batch.
16. Use a host-side render tool for long renders.
17. Self-review frames before every handover.
18. Archive with a manifest, checksums, and a second copy.

## What not to do

- Do not add a general-purpose animation framework on top of this. It is a
  map-clip kit.
- Do not let scenes carry raw colors or motion numbers. The look drifts.
- Do not auto-compute exclusions. Hand-author them.
- Do not render attribution or title cards. Composite them.
- Do not trust a render you have not looked at.
