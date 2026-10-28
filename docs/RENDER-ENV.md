# Render environment

## Requirements

- Node 20 or newer.
- Playwright Chromium: `npx playwright install chromium`.
- ffmpeg with `prores_ks` support.
- A network connection for the default hosted OpenFreeMap tiles, unless you
  use a local PMTiles extract.

## Versions used by the original project

These are the versions the kit was extracted from. Newer versions should work;
pin them if you need reproducible output.

- macOS 26.5.2
- Node 25.8.1
- Playwright 1.62.1
- Chromium headless shell 1243
- ffmpeg 8.0.1

The repo pins Node dependencies in `package-lock.json`. Chromium and ffmpeg
are not pinned by the repo.

## Install

```sh
npm install
npx playwright install chromium
```

## Validate

```sh
npm test
```

This runs the optional geo validator and the scene validator. Both are
zero-dependency.

## Render

```sh
npm run render -- scenes/demo-01-city-tour.json
```

Output:

```
renders/demo-01-city-tour-full.mov
renders/render-log-demo-01-city-tour-full.json
```

Set `MAP_RENDER_OUT` to write elsewhere:

```sh
MAP_RENDER_OUT=/tmp/my-renders npm run render -- scenes/demo-01-city-tour.json
```

## Probe one frame

```sh
npm run probe -- scenes/demo-01-city-tour.json 72 --out=/tmp/probe
```

The probe runs the same page, camera law, and paint order as the full render,
without the frame loop.

## Camera picker

```sh
npm run camera-picker
```

Open `http://127.0.0.1:8123/tools/camera-picker/page/index.html`.

## Portability notes

- The renderer uses `--enable-unsafe-swiftshader` because hardware GPU
  acceleration crashes headless Chromium on some machines.
- Finder reveal (`open -R`) is macOS-only. Pass `reveal: false` to the render
  tool on other platforms.
- The default style uses hosted OpenFreeMap tiles. For offline renders, use a
  local PMTiles extract as described in `data/tiles/README.md`.
- The render page is served over a loopback HTTP server. It does not use
  `file://`.

## Troubleshooting

**The render hangs after a camera move.** Use `jumpTo` plus
`areTilesLoaded()` and a settle. Do not use `once('idle')`.

**Pins flicker on camera moves.** Set subpixel positioning on every DOM
marker.

**The half strip is misframed.** The camera center is the strip center. Use
512 px tile math.

**The last frames are empty.** A window ends at the scene length and the
default fade-out dissolved the element. Set `fade-out: 0`.

**A one-element slideWindow does nothing.** Author two elements.

**The render dies at 120 s in a shell.** Use the repo render tool or run the
render detached and poll. See `.opencode/rules/renders.md`.
