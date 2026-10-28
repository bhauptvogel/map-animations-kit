# Recipe registry

`recipes/recipes.json` is the recipe book: every named motion or styling law
the renderer applies, with its tunable parameters and defaults. Scenes never
carry raw motion numbers; they reference recipes by name. Per-scene deviations
go through an `overrides` object at the element that carries the Window.

`recipes/recipes.json` is normative for names, kinds, parameter names, types,
defaults and enum values. This document explains semantics and deliberately
repeats no numbers, so the two cannot drift. If they ever disagree, the JSON
wins; fix this document.

## JSON shape

```jsonc
{
  "<recipe-name>": {
    "kinds": ["element-kind", "…"],   // where the name may appear; [] = renderer-wide
    "params": {
      "<param-key>": {                // exactly the accepted override keys
        "type": "number | enum | boolean",
        "default": 0,
        "values": [],                 // enum only
        "min": 0, "max": 1            // optional number range
      }
    }
  }
}
```

- `kinds: []` means a renderer-wide default. The name never appears in scene
  JSON, so it accepts no overrides from scenes.
- Colors never appear here. Every color and alpha is a frozen style token.
  Recipes own motion and geometry only.
- The validator reads this file: unknown recipe names and unknown override
  keys are errors. The renderer imports the same file for defaults.

## Overrides: the Window-carrier rule

The object carrying the Window carries `overrides`: one optional object, empty
by default, keys checked against the referenced recipe's params.

| Element | Slot | Recipe |
|---|---|---|
| Exclusion | `entry.overrides` | `entry.recipe` |
| Camera | `camera.overrides` | `waypoint-glide` |
| Pin move | `moves[i].overrides` | `pin-glide` |
| Pin level | `seekers`/`hider` object | `pin-fade` |
| Ride | `rides[i].overrides` | `ride-highlight` |
| Label | `labels[i].overrides` | `label-fade` |
| Label grow | `labels[i].overrides` when `grow` is present | `dot-grow` |
| Label pulse | `labels[i].overrides` when `pulse` is present | `dot-pulse` |
| Line entrance | `lineEntrances[i].overrides` | `line-fade` |
| Free point | `points[i].overrides` | `point-fade` |
| Segment | `segments[i].overrides` | `segment-draw` |
| Path | `paths[i].overrides` | `path-highlight` |
| Circle | `circles[i].overrides` | `circle-draw` |

## The recipes

### `present-from-start` (exclusions)

Exclusion is visible at full styling from frame 0. No window, no params.

### `blink-then-stay` (exclusions)

Mid-clip exclusion entry: the striped area blinks a few times at near-zero
alpha, then settles to permanent full styling. Fixed-time law: the rhythm does
not stretch with the entry window. The window is required.

- `blinks`: number of on/off cycles at the window start. The rhythm opens on
  the light beat.
- `cycle`: seconds per on/off cycle.
- `blink-alpha`: alpha during light beats.
- `settle`: seconds of smoothstep settle from the last on-beat to full.

Total entry time = `blinks × cycle + settle`. The validator errors when the
window is missing and warns when the window is shorter than the law needs.

### `exclusion-stripes` (renderer-wide)

Violet stripe geometry for exclusions, with the outline trimmed where
exclusions overlap. Colors and alphas are frozen tokens, not params. No
per-scene overrides.

The pattern phase anchors to the Web-Mercator ground plane: the grid
translates and scales with the camera exactly like basemap geometry, so stripes
never slide against the basemap during camera moves. `spacing-px` is exact at
the scene's time-average zoom (the numeric integral of the eased waypoints over
the scene length). A static camera reduces to that single zoom.

- `spacing-px`: distance between stripe centerlines in ground space at the
  scene's time-average zoom.
- `weight-px`: stripe stroke width.
- `angle-deg`: stripe angle.
- `outline-px`: outline stroke width around each exclusion.

### `outside-playfield` (renderer-wide)

Stripe geometry for the outside-playfield mask (a dark fill plus stripes in a
lighter tone). Painted last so exclusions read behind the boundary. Same
geometry as `exclusion-stripes`, no outline. Ground-anchored like the
exclusion stripes. The stripe color is a frozen token.

- `spacing-px`, `weight-px`, `angle-deg`.

### `waypoint-glide` (camera)

Default easing law between camera waypoints. A single `overrides` on the
camera applies to all segments. Omitted camera = static.

- `easing`: `smoothstep`, `linear`, `ease-in`, or `ease-out`.
- `path`: `segment` (default, zero velocity at every waypoint) or `spline`
  (one C1 cubic Hermite through all waypoints in time; interior waypoints are
  passed at speed; only first and last ease from/to rest; `easing` ignored).

### `pin-glide` (seekers, hider)

Same law for both pins. Per-move `overrides` apply per beat.

- `easing`: a member of the easing library.
- `from-progress`, `to-progress`: optional fractional endpoints (0-1, arc
  length along the from-to segment of the ridden line). Per-move overrides
  only. The renderer resolves them against the line geometry; scene JSON never
  carries the coordinates. Absent on both = exact station endpoints.
- Duration is author-owned: every move carries a window. There is no
  per-distance speed law. Typical pacing guidance is 1.5-4 s for a hop, longer
  for long hauls.
- Coordinate moves (`from-coord`/`to-coord`) glide a straight chord; `line` is
  ignored on pure coordinate moves.

### `pin-fade` (seekers, hider)

Pin-level visibility: the whole pin (photo, spike, label) fades in at the
window start and out at the window end. Fades are clamped to half the window,
so a short window never pops. Outside the window the pin is fully hidden. No
window = visible for the whole scene.

- `fade-in`, `fade-out`.

### `ride-highlight` (rides)

The band renders as alternating equal-length segments of the official line
color and white, oriented along the ride direction. Segment geometry is a
screen-space dash pattern measured in px along the projected path; the color
segments crawl forward along the path at a fixed screen-space speed. The band
geometry stays static; the motion belongs to the stripes. Phase is derived from
scene time, so renders stay deterministic.

Fades at the window edges are clamped to half the window. Band width is a
renderer constant.

- `dash-px`: one color segment's length along the path.
- `gap-px`: one white segment's length.
- `outline-px`: white outline around the band (underlay stroke at band width
  plus twice this value).
- `flow-px-per-s`: forward crawl speed of the color segments. `0` = static.
- `fade-in`, `fade-out`.

### `label-fade` (labels)

Station label fade in/out at the window edges, each clamped to half the window.
A label never pops in un-faded.

- `fade-in`, `fade-out`.

### `dot-grow` (labels)

Mid-clip dot-size emphasis: a label's dot (never the name text) scales from its
frozen size up to a scene-authored multiple, starting at the label's `grow-at`
timecode, then stays grown. The amplitude (`grow`) is scene-authored; the law
(duration) lives here.

- `grow-in`: seconds of smoothstep from scale 1 to the grown scale.

Scene fields: `labels[].grow` (target scale ≥ 1) and `labels[].grow-at`
(timecode). Both optional. An inert `grow-in` override without the scene
fields is an error.

### `dot-pulse` (labels)

Mid-clip pulse of a label's dot (never the name text): the dot scales from 1 up
to a scene-authored multiple starting at `pulse-at`, holds briefly, then
returns to 1. Grows and recovers, unlike `dot-grow` which stays grown.

- `pulse-in`: seconds of smoothstep up.
- `pulse-hold`: seconds at the top.
- `pulse-out`: seconds of smoothstep back to 1.

Scene fields: `labels[].pulse` (target scale ≥ 1) and `labels[].pulse-at`
(timecode), mutually exclusive with `grow`/`grow-at`. Pulse and grow compose
with `dot-scale` (scene-authored base-size multiplier, not a recipe param).

### `line-fade` (lineEntrances)

Mid-clip line entrance: the full Line geometry fades in over `fade-in` at its
window start and stays on to the scene end. The additive cousin of the static
`lines` list. At most one entrance per line; a line in both `lines` and
`lineEntrances` is a validation error.

- `fade-in`, `fade-out`.

### `point-fade` (points)

Free-point fade: dot and text fade together. Outside the window the point is
hidden. Same clamped law as `label-fade`.

- `fade-in`, `fade-out`.

### `segment-draw` (segments)

A straight two-point line between hand-authored coordinates, drawn on the
stripe canvas after the outside mask, before the divider. The tip draws from
`coords[0]` toward `coords[1]` over `draw-in` at the window start, then
retracts over `draw-out` at the window end. Fade smooths both edges. Every span
is clamped to at most half the window. A `draw-in` of 0 means fully drawn from
the first frame of the window.

- `draw-in`, `draw-out`, `fade-in`, `fade-out`.

### `circle-draw` (circles)

A context circle around a hand-authored center: a thin violet rim that draws
clockwise from north (tip grows over `draw-in` at the window start), then
retracts backward over `draw-out` at the window end. Fade smooths both edges.
No fill, no stripes. The radius (`radius-m`, meters, great-circle) and center
are scene-authored.

- `draw-in`, `draw-out`, `fade-in`, `fade-out`.

### `path-highlight` (paths)

A walking-route highlight along a hand-authored multi-point polyline. Renders
in the ride-highlight look (same screen-space dash law, white outline underlay,
dash crawl) in grey. The band color is a frozen renderer token with an optional
per-path scene color. The dash crawl runs in route direction.

Drawn after Ride highlights, before the outside mask; the polyline projects per
frame. On top of the ride fades, the tip can draw on along the route
(`draw-in`, arc-length exact, no vertex snapping) and retract (`draw-out`).
Both default to 0, which means a plain ride-style fade.

- `dash-px`, `gap-px`: color/white segment lengths along the route.
- `width-px`: band width.
- `opacity`: global alpha of the whole path.
- `base`: paint the white dash base. `false` lets the map show through the
  gaps; useful for a walking trace that must not read as a ride.
- `outline-px`: white outline around the band.
- `flow-px-per-s`: forward crawl speed of the color dashes.
- `draw-in`, `draw-out`, `fade-in`, `fade-out`.

`paths[].append` (`{ from, window, easing }`) keeps the already-walked prefix
(fraction `from`) drawn and grows the suffix over the window with the given
easing. It is one path object, so the dash phase stays continuous across a
walking trace's live leg. `append` replaces `draw-in`/`draw-out` on that path.

## The easing library

Four members:

- `smoothstep`: `c²(3−2c)`, the default everywhere.
- `linear`: constant speed; for ride-along shots and constant-speed walking.
- `ease-in`: quadratic (`c²`), starts at rest, accelerates to full speed.
- `ease-out`: quadratic (`1−(1−c)²`), starts at full speed, decelerates to
  rest.

More members join additively: edit `recipes.json` values, implement the member
in the renderer, and update this section.

## The fade law

Window start is inclusive. A zero fade short-circuits to fully on. Fades are
clamped to at most half the window, so a short window never pops un-faded. The
window end is exclusive and hard-zeroes the element.

If a window ends at the scene length, the default fade-out dissolves the
element over the last fraction of a second. Set `fade-out: 0` when the element
must persist to the last frame.
