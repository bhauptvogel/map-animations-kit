# Camera picker

An interactive waypoint picker for scenes. The map is rendered at the exact
framing geometry the renderer uses, so the zoom values you pick match the
render 1:1.

## Start

```sh
npm run camera-picker
# or: node tools/camera-picker/server.mjs --port=8123 --no-open
```

Open `http://127.0.0.1:8123/tools/camera-picker/page/index.html`.

## Use

- **Framing**: `full` (1920×1080), `half` (806×1080, left strip), `half-right`
  (806×1080, right strip), `half-bottom` (1920×454, bottom strip). The map
  element is exactly strip-sized, so zoom matches the renderer. The
  transparent area is hatched and the divider sits on the strip edge.
- **Move the camera**: drag to pan, scroll to zoom, right-drag for bearing,
  ctrl-drag for pitch.
- **Add a waypoint** (or press `C`): capture the current view. The first is IN,
  the last is OUT; any number of intermediate waypoints is allowed.
- **Time basis**: scene length, or source-video timepins. In timepin mode,
  `start_at` and `end_at` define the clip; waypoint `at` values carry source
  time and are translated to scene time frame-exactly at 24 fps.
- **Overlays**: edit `tools/camera-picker/overlays.json`, then press the reload
  button. Schema per entry:
  - `type: "circle"`: `center: [lng, lat]`, `radius-m`, `color`, `width-px`
  - `type: "line"`: `points: [[lng, lat], …]`, optional `dash-px`, `color`,
    `width-px`
  - `type: "point"`: `coord: [lng, lat]`, optional `label`, `color`,
    `radius-px`
  - `type: "polygon"`: `points: [[lng, lat], …]` (closed ring), `color`,
    `width-px`, `dash-px`, `fill-opacity`
  - `"on": true|false` sets the initial toggle state.
- **`at` timecode** per waypoint is editable (`MM:SS:FF` at 24 fps, or
  `HH:MM:SS:FF` past 10 minutes). A single waypoint is a static camera.
- **Output**: a `scene` block with framing and optional length, plus `camera`
  and optional `slideWindow`. Copy the block into a scene or an agent prompt.
- **Slide in/out** (half framings only): emits
  `slideWindow: ["00:00:00", end - 1s]`.
- **Easing**: `smoothstep` (default, not emitted) or `linear` (emitted as
  `camera.overrides.easing`).
- **Preview**: the slider follows the eased camera path. IN/OUT jumps to the
  endpoints. Preview needs `at` on all waypoints.
- **Waypoint actions**: jump to a waypoint, overwrite it with the current view,
  reorder, delete.
- **Copy waypoints**: emits 6-decimal centers and 3-decimal zoom, ready for the
  scene validator.
- **Import**: paste an existing `camera.waypoints` block or a bare array.

The tool works without geo data. If you add a playfield boundary or lines, they
appear in the picker.
