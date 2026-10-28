# Scene format

A scene is one declarative JSON file describing a clip. The renderer
interprets it. Scenes never carry raw colors or raw motion numbers; they
reference named recipes.

## File conventions

- Scenes live in `scenes/`, flat, named
  `<project>-<nn>-<slug>.json` or `<project>-intro-<nn>-<slug>.json`.
- `<project>` is any lowercase slug (`demo`, `series-a`, …). `<nn>` is two
  digits. `<slug>` is kebab-case.
- Shared exclusion shapes live in `scenes/shapes/<slug>.geojson`.
- Every scene validates against `scripts/validate-scene.mjs`.

The `scene.video` field must match the `<project>` part of the filename. The
field name is historical; it is a project or series slug, not necessarily a
video.

## Time model

- All time is strict `(HH:)MM:SS:FF` at 24 fps.
  `00:08:00` = 8 seconds and 0 frames. Hours are optional.
- Frames `FF` are 00-23, seconds `SS` are 00-59. Bare seconds or floats are
  invalid.
- Each timed element carries a `window: [start, end]`.
- The scene carries an explicit `length`. Every window and camera waypoint
  must fit inside `[00:00:00, length]` and have `start < end`.
- The renderer honors `length` exactly, including late-window tail padding.
- Camera waypoints use a single `at` timecode instead of a window.

## Top-level schema

```jsonc
{
  "scene": {
    "video": "demo",             // required: lowercase project slug
    "nn": 1,                     // required: matches filename <nn>
    "title": "City Tour",        // required: authoring label, never rendered
    "length": "00:06:00",        // required: strict timecode
    "framing": "full"            // required: full | half | half-right | half-bottom
  },
  "slideWindow": [],             // optional half-strip slide in/out
  "streets": false,              // optional close-zoom street detail
  "camera": { "waypoints": [] }, // optional; omit for a static shot
  "lines": [],                   // static lines, on from frame 0
  "lineEntrances": [],           // full lines fading in mid-clip
  "exclusions": [],              // hand-authored areas
  "rides": [],                   // highlighted line segments
  "seekers": {},                 // the Seeker group pin
  "hider": {},                   // optional second pin
  "labels": [],                  // station dot + geo-db name
  "points": [],                  // free dot + scene text
  "segments": [],                // straight two-point lines
  "paths": [],                   // route polylines and walking traces
  "circles": []                  // context circles
}
```

There is no version field. Unknown fields warn; additive changes do not break
existing scenes.

## `camera`

```jsonc
"camera": {
  "waypoints": [
    { "at": "00:00:00", "center": [13.407, 52.518], "zoom": 13.4 },
    { "at": "00:06:00", "center": [13.412, 52.520], "zoom": 14.2,
      "bearing": 0, "pitch": 0 }
  ],
  "overrides": { "path": "spline" }
}
```

- Waypoints sorted by `at`; first must be `00:00:00`; all points ≤ `length`.
- `bearing` and `pitch` are optional, default 0.
- Omitted camera or a single waypoint = static.
- `overrides.easing`: `smoothstep` (default), `linear`, `ease-in`,
  `ease-out`.
- `overrides.path`: `segment` (default) eases each segment independently, so
  velocity is zero at every waypoint. `spline` glides one C1 cubic Hermite
  through all waypoints in the time domain; interior waypoints are passed at
  speed, only first and last ease from/to rest. `easing` is ignored in spline
  mode. With two waypoints both modes coincide.
- Camera `center` is a hand-authoring exception. It is a framing choice, not a
  geo-db entity.

## `slideWindow`: half-strip slide

```jsonc
"slideWindow": ["00:08:00", "00:09:12"]
```

- Only for `half`, `half-right`, and `half-bottom`.
- The whole map strip (map, stripe canvas, divider) slides in from its
  transparent edge at `slideWindow[0]` (default `00:00:00`) and slides back out
  at `slideWindow[1]` (absent = never exits).
- 16 frames each way, smoothstep, axis-agnostic. Full-frame scenes ignore it.
- Always author two elements. A one-element array currently disables the whole
  slide because the timecode conversion expects a pair.

## `streets`: close-zoom street detail

```jsonc
"streets": true
```

- Boolean opt-in for the basemap's minor street layers (`tertiary`/`minor`,
  `service`, `path`/`track`, LineStrings).
- The layers ship hidden and with `minzoom: 14`; `true` only flips their
  visibility. Absent/false leaves the basemap unchanged.
- Below zoom 14 nothing changes even when enabled.
- Not a recipe. Basemap styling is renderer-owned.

## `lines`: static line list

```jsonc
"lines": ["line-a", "line-b"]
```

- Line slugs resolve against `data/geo/lines/`.
- The line's official `color` is the single source of truth for line and label
  color.
- Rendered full geometry from frame 0. There is no draw-on field.

## `lineEntrances`: full lines fading in

```jsonc
"lineEntrances": [
  { "line": "line-a", "window": ["00:00:08", "00:00:28"] },
  { "line": "line-b", "window": ["00:00:11", "00:00:28"] }
]
```

- The full Line geometry fades in over the window via the `line-fade` recipe.
- Additive. At most one entrance per line.
- A line in the static `lines` list is always on from frame 0 and wins; an
  entrance on the same slug is a validation error.
- In-playfield station dots during an entrance ride on `dot-only` labels, not
  on the entrance itself.

## `exclusions`

```jsonc
"exclusions": [
  {
    "id": "block",
    "shape": {
      "type": "Polygon",
      "coordinates": [[[13.392, 52.522], [13.405, 52.522],
                       [13.405, 52.532], [13.392, 52.532],
                       [13.392, 52.522]]]
    },
    "entry": { "recipe": "blink-then-stay", "window": ["00:02:00", "00:04:00"] }
  },
  {
    "id": "shared-zone",
    "shape": "shared-zone",
    "entry": { "recipe": "present-from-start" }
  }
]
```

- `shape` is either inline GeoJSON (Polygon/MultiPolygon, WGS84, 6-decimal
  rounding) or a string slug of a shared shape in
  `scenes/shapes/<slug>.geojson`.
- `entry.recipe`:
  - `present-from-start`: visible from frame 0, no window.
  - `blink-then-stay`: appears mid-clip, window required. The blink rhythm and
    settle are recipe internals.
- `entry.overrides` is the per-scene recipe override slot.
- Exclusions are additive only. Nothing un-excludes an area mid-scene. Areas
  leave the excluded state by moving to the next scene.
- Overlap styling (union striping, outline trim, paint order behind the
  playfield mask) is renderer behavior, never declared.

## `seekers` and `hider`: the two pins

At most two pins may exist on screen: one `seekers` and one optional `hider`.

```jsonc
"seekers": {
  "photo": "assets/images/placeholder-seeker.svg",
  "start": { "station": "central-station" },
  "moves": [
    { "from": "central-station", "to": "next-station",
      "window": ["00:05:12", "00:08:00"] }
  ]
},
"hider": {
  "photo": "assets/images/placeholder-hider.svg",
  "start": { "coord": [13.418, 52.522] },
  "moves": [],
  "tilt": -5
}
```

- The pin is a group entity: photo, spike, and a renderer label
  "Seeker" or "Hider". Labels are renderer constants, never scene fields.
- `photo` is repo-root-relative, under `assets/images/` by convention.
- `start` is a station slug or a hand-authored `coord` ([lon, lat]). The two
  are mutually exclusive.
- Pin-level `window` (optional) fades the whole pin in and out via
  `pin-fade`.
- A move glides `from` to `to` over its window. Consecutive moves must chain
  (`to` equals the next `from`).
- A move may carry `line` plus `overrides` with `from-progress`/`to-progress`
  (0-1, arc length along that line's from-to segment). The move then starts or
  ends between stations without coordinates in the scene.
- A move may instead carry `from-coord`/`to-coord` (hand-authored [lon, lat],
  mutually exclusive with `from`/`to` per endpoint). The pin glides a straight
  chord. Chaining still holds.
- `tilt` (optional, degrees, -60 to 60) rotates the pin body about the spike
  tip. Negative tilts left. Absent/0 is the upright look.
- A progress move without `line` falls back to a straight chord; always put
  `line` on a progress move.

## `rides`

```jsonc
"rides": [
  { "line": "line-a", "from": "central-station", "to": "next-station",
    "window": ["00:05:12", "00:08:00"] }
]
```

- A Ride is the highlighted segment of a line showing where a group is
  traveling. It is not a pin movement.
- `from` and `to` must be stations of that line, in either direction.
- Look: the line's official color with white dashes crawling in the travel
  direction. Metrics are the `ride-highlight` recipe.
- Window-bound; absent outside the window.
- Full lines are usually pre-drawn via `lines`; rides decorate part of them.

## `labels`

```jsonc
"labels": [
  { "station": "central-station", "line": "line-a",
    "window": ["00:03:09", "00:03:18"] }
]
```

- A label is a dot plus the geo-db station `name`. Scenes never carry the
  display text.
- `line` (optional) colors the dot ring and text with that line's official
  color. Without it the label is neutral.
- Fades in and out over the window via `label-fade`.
- `dot-only: true` renders the dot without the name.
- `grow` (target scale ≥ 1) plus `grow-at` (timecode) scales the dot, never
  the text, over `dot-grow`'s `grow-in` and stays grown.
- `pulse` (target scale ≥ 1) plus `pulse-at` (timecode) scales the dot up,
  holds, and returns to 1 via `dot-pulse`. Mutually exclusive with
  `grow`/`grow-at`.
- `dot-scale` (0.05-3, default 1) is a base-size multiplier for the dot only.
- `label-scale` (0.5-3, default 1) is a text-size multiplier for the text only.
- `label-side: "left"` flips the text to the dot's west side; default right.
- `label-dy` is a pixel vertical offset, negative = up.

## `points`: free points

```jsonc
"points": [
  { "coord": [13.402, 52.516], "text": "Start",
    "window": ["00:00:12", "00:05:12"] },
  { "coord": [13.418, 52.522], "text": "Two\nlines",
    "color": "#D6336C", "scale": 1.6, "window": ["00:01:00", "00:06:00"] }
]
```

- A free point is not a station. It is a hand-authored dot plus scene-carried
  text, the one deliberate exception to geo-db-only text.
- `text` is required and non-empty. Explicit `\n` renders as a line break.
- `color` (optional, `#RRGGBB`) colors the dot ring and text. Default is the
  frozen black free-point token.
- `scale` (optional, 0.3-3) is a dot and text size multiplier.
- Fades in and out over the window via `point-fade`.
- `label-side` and `label-dy` place the text.

## `segments`: straight two-point lines

```jsonc
"segments": [
  { "coords": [[13.398, 52.512], [13.428, 52.530]],
    "window": ["00:01:00", "00:05:00"] }
]
```

- A straight line between two hand-authored coordinates, drawn on the stripe
  canvas after the outside mask, before the divider.
- Default look: solid violet, thin, no fill.
- Motion: the tip draws from `coords[0]` to `coords[1]` over `draw-in` at the
  window start and retracts over `draw-out` at the window end
  (`segment-draw`). Fade smooths both edges.
- Endpoints project per frame, so camera moves stay correct.

## `circles`: context circles

```jsonc
"circles": [
  { "center": [13.420, 52.518], "radius-m": 700,
    "window": ["00:00:00", "00:04:00"] }
]
```

- A thin violet rim, no fill, no stripes, around a hand-authored center at a
  great-circle `radius-m`. The "radius around the group" look before an area
  becomes a striped Exclusion.
- Motion: the rim tip draws clockwise from north over `draw-in` at the window
  start and retracts backward over `draw-out` at the window end
  (`circle-draw`). Fade smooths both edges.
- Overlapping active circles are stroked as one union outline. Rim pieces
  inside another circle's disc are trimmed.
- Circles and segments are clipped to the playfield when one exists.

## `paths`: route polylines and walking traces

```jsonc
"paths": [
  { "coords": [[13.402, 52.516], [13.407, 52.518], [13.412, 52.520]],
    "color": "#3E4754",
    "window": ["00:00:00", "00:06:00"],
    "overrides": { "draw-in": 2, "draw-out": 0 } }
]
```

- A multi-point polyline between hand-authored coordinates. Not a line, not a
  ride, not a segment: a route overlay of N points.
- Default look: the ride-highlight vocabulary in grey, with a white outline
  and white dashes crawling in route direction. `color` optionally overrides
  the band color.
- Motion: `path-highlight`. The tip can draw on along the polyline
  (`draw-in`, arc-length exact) and retract (`draw-out`). Both default to 0,
  which means a plain fade like a ride.
- For a walking trace, set `base: false`, a thin `width-px`, no `outline-px`,
  a dark color, and `flow-px-per-s: 0` so it reads as static ground, not a
  ride.
- `append: { from, window, easing }` keeps the already-walked prefix (fraction
  `from`) drawn and grows the suffix over the window with the given easing.
  It is one path object, so the dash phase stays continuous across the
  junction. `append` replaces `draw-in`/`draw-out` on that path.
- Drawn after Ride highlights, before the outside-playfield mask.

## Recipes and overrides

Every recipe reference may carry a sibling `overrides` object for per-element
parameter overrides. Override names are defined by `recipes/recipes.json`. The
validator rejects unknown recipe names and unknown override keys.

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

## Data is truth

Stations and lines may only be referenced by slug, in `moves`, `rides`,
`labels`, and `lines`. Scene JSON cannot contain coordinates that duplicate a
geo-db entity; the renderer resolves everything against `data/geo/`.

Raw coordinates appear only where hand-authoring is the point: camera centers,
exclusion and shape geometry, pin coordinates, free points, segments, circle
centers, and path polylines.

## What scenes never contain

- Attribution or title cards. Composite them in your editor.
- Free-rendered text. Every string is a geo-db station name, a renderer
  constant ("Seeker"/"Hider"), or `points[].text`.
- Raw hex colors, stripe metrics, or easing numbers, except the fields the
  format explicitly grants (`points[].color`, `paths[].color`).
- More than two pins.
- Framing logic. `framing` selects it; the renderer maps the scene to the
  strip or full frame.

## Paint order

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

Scenes cannot reorder it. Segments and circles are clipped to the playfield.
Exclusions with an identical entry blink as one union group.

## Validation contract

**Errors (block):**

- JSON parses; required fields present; `framing` in enum;
- filename matches `<project>[-intro]-<nn>-<slug>.json` and the `scene`
  fields;
- timecodes strict; `start < end`; windows and waypoints within
  `[00:00:00, length]`;
- every station slug resolves in `data/geo/stations/stations.geojson`; every
  line slug resolves in `data/geo/lines/`;
- ride `from`/`to` are stations of the ridden line; consecutive moves chain;
- shared shape refs resolve and parse as Polygon/MultiPolygon; inline shapes
  are valid RFC 7946;
- recipe names exist in the registry; override keys exist;
- at most one `seekers`, one `hider`;
- duplicate exclusion ids; a line in both `lines` and `lineEntrances` or
  entered twice;
- `grow`/`pulse` mutually exclusive; `grow-at`/`pulse-at` beyond scene length.

**Warnings (never block):**

- unknown fields (the versioning mechanism);
- co-window overlaps (authoring nudge);
- missing photo asset;
- move windows not contiguous.

## Versioning

There is no version field. Unknown fields warn. Adding an element kind, a
field, or a recipe name is additive. Breaking changes get a note in this
document and a migration path.

## Example

The full demo is `scenes/demo-01-city-tour.json`. It uses hand-authored
coordinates, so it needs no geo data. It exercises camera, exclusion, circle,
segment, path, free points, both pins, and the full framing.

`scenes/demo-02-half-strip.json` shows the half framing, the slide, and the
transparent alpha side.
