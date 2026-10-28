---
description: Mandatory when running a render. A scene render takes 0.5-1 s per frame plus encode (2-15 min), far beyond the bash tool's 120 s kill, which truncates the render and leaves no master. Use the repo-local `render` tool (`.opencode/tools/render.ts`) — it runs inside the opencode host, is not subject to that kill, and returns when the masters exist, so you continue immediately after it finishes.
---

# Renders

A render is one screenshot per frame (0.5-1 s each) plus the ProRes encode:
minutes for a real scene. The bash tool kills a command after **120 s** by
default, so a plain `node render/render.mjs <scene>` in a bash call dies
mid-run and leaves no master.

## Use the `render` tool (this repo)

`.opencode/tools/render.ts` is a **repo-scoped custom tool**.

```
render({ scenes: ["scenes/<file>.json"] })                  // one scene
render({ scenes: ["scenes/a.json", "scenes/b.json"] })       // parallel
render({ scenes: [...], reveal: false })                    // skip Finder
```

- It spawns `render/render.mjs` to completion inside the opencode host, so the
  bash 120 s kill does not apply. The call returns only when the render is
  finished.
- Several scenes render in parallel (each render binds an ephemeral port, uses
  its own Chromium profile and its own per-scene frames dir).
- Relative scene paths resolve against the project root, which the tool finds
  by its own markers (`render/render.mjs` + `recipes/recipes.json`).
- Output lands flat in `./renders/` (`<stem>-<variant>.mov` plus
  `render-log-<stem>-<variant>.json`) unless `MAP_RENDER_OUT` is set. On success
  the tool reveals the master in Finder; pass `reveal: false` on non-macOS.
- A hard cap of 45 min per scene (`timeoutMinutes` to change) kills a hung
  render. Re-running is safe: `render.mjs` clears its per-scene frames dir at
  the start of each variant.
- New or changed tools only load on opencode start: after editing
  `render.ts`, restart before using it.

## Fallback (tool missing / not yet restarted)

There is no opencode config key for a command timeout. The per-call `timeout`
argument in milliseconds is `frames × 1500 + 120000` (frames = length × 24).
If the command is still killed at exactly 120 s, the argument did not reach
the tool. Then run it detached and poll:

```sh
nohup node render/render.mjs scenes/<file>.json > /tmp/render-<stem>.log 2>&1 &
# later, in separate short calls:
pgrep -fl "render.mjs scenes/<file>.json" || tail -5 /tmp/render-<stem>.log
```

The log ends with `all framings rendered` on success; hard errors print the
reason.

After a successful render, review frames yourself (see the create-scene skill,
step 5).
