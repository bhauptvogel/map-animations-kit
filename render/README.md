# render/

The production renderer. It owns no choreography: every number comes from the
scene (`scenes/*.json`) or the recipe registry (`recipes/recipes.json`). Look
tokens are renderer constants. Stations, lines and colors resolve from the
optional `data/geo/`.

## Run

```sh
node render/render.mjs scenes/demo-01-city-tour.json
node render/render.mjs scenes/… --framing=full      # must match the scene
node render/render.mjs scenes/… --keep-frames       # keep PNG frames
node render/render.mjs scenes/… --port=8123         # pin the loopback port
```

Output lands in `./renders/` unless `MAP_RENDER_OUT` is set:

```
<stem>-<variant>.mov
render-log-<stem>-<variant>.json
```

One scene equals one framing. `--framing` must select exactly the scene's
framing or the renderer hard-errors.

Pre-flight: `node scripts/validate-scene.mjs scenes/<file>.json`. A scene that
fails validation does not render.

## Layout

- `render.mjs`: validate, resolve, serve, capture, encode.
- `server.mjs`: loopback HTTP server, optional PMTiles range requests, scene
  injection.
- `geo.mjs`: optional slug resolution against `data/geo/`.
- `page/index.html` + `page/page.js`: MapLibre page, pins, labels, free points,
  stripe canvas, `window.__frame(frame)`.
- `interpreter.js`: browser-side motion laws (easing, fades, blink, dot
  grow/pulse, pin glide, camera, stripes, rides, paths, circles).
- `validate-for-render.mjs`: runs `scripts/validate-scene.mjs`.

## Invariants

- Determinism: same scene + same geo data + same tiles + same renderer =
  pixel-identical output. Drive from `t = frame / 24`; no MapLibre animation
  APIs; no CSS-driven marker fades; stripes never `fill-pattern`.
- Every DOM marker uses subpixel positioning.
- Paint order: basemap → playfield outline → static lines → exclusion stripes →
  ride highlights → walking paths → outside mask → segments → circles →
  divider → DOM overlays.
- Chromium arg `--enable-unsafe-swiftshader` is mandatory on machines where
  hardware GPU acceleration crashes headless Chromium.
- Never render attribution or title cards. Composite them in your editor.

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) and
[`../docs/DESIGN-NOTES.md`](../docs/DESIGN-NOTES.md).
