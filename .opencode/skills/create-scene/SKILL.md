---
name: create-scene
description: "Create a new map scene (scenes/*.json) for this kit: interview the user, author the scene JSON, validate it, render it, and self-review frames before handing over. Fires whenever the user asks to create, author, or add a new scene/clip."
---

# Create a scene

Author one declarative scene JSON (`scenes/<project>-<nn>-<slug>.json` or
`scenes/<project>-intro-<nn>-<slug>.json`), validate it, render it, and review
the frames yourself before the user sees anything.

The scene format is documented in `docs/SCENE-FORMAT.md`. The renderer
interprets scenes; it owns no choreography. Text is scene-authored (station
names from the geo db, `points[].text`, or the "Seeker"/"Hider" constants).

## Step 1: Interview (never skip; no defaults for these)

Ask before writing any JSON. Batch the questions; ask follow-ups when an
answer is ambiguous. Do not guess on any of these:

1. **Project and number.** Which project slug and scene number? Check
   `scenes/` for existing files and propose the next `nn`.
2. **Framing.** `full`, `half` (806 px left strip, 42% of the frame),
   `half-right` (806 px right strip), or `half-bottom` (1920×454 bottom
   strip). The user convention is that "half" means the left strip unless
   they say otherwise. Full scenes have no slide in/out.
3. **Length.** Strict timecode at 24 fps (`00:10:00` = 10 s). The user may
   give a start and end timecode from an existing timeline instead. Convert
   the length by subtracting start from end, and re-base every event timecode
   by subtracting the start.
4. **Story beats.** What happens: pins (Seeker and/or Hider, station or
   coordinate, moves), lines and rides, exclusions (area and entry recipe),
   labels, free points, segments, paths, circles. The user narrates; you
   translate into scene vocabulary.
5. **Camera.** Always ask. Static, push-in, pull-back, or a custom path? For
   half framings, also ask what the end frame must show.

## Step 2: Base scene (inherit instead of re-author)

Ask whether an existing scene is the base. If yes:

- Read the base scene JSON.
- Carry over `lines`, `exclusions`, and any element the user does not
  explicitly change; keep their windows unless the user re-times.
- The new scene's `length` may differ. Windows that must survive the retime
  get scaled or pinned explicitly; ask which.
- Copy photo paths from the base scene unless told otherwise.
- State what you carried so the user can veto individual elements.

For context, look at other scenes from the same project first. Other projects
are reference only; do not copy content blindly.

### Walking trace (endgame scenes)

- **Walking trace**: the cumulative dashed line (`paths[]`) showing ground
  actually walked. It is one path object and one dash phase, continuing across
  scenes. Never split it into one object per scene.
- **New points along the walked path**: waypoints the user gives you that were
  walked before this clip starts. Append them to the trace's `coords` after the
  previous scene's last point. They are history: visible from frame 0, no
  animation, and the pin already stands at the last of them.
- **New walking trace / live leg**: the stretch walked inside this clip. It is
  the suffix of the same trace, revealed by `append`.

Authoring an endgame scene:

1. `coords` = previous scene's trace + any new already-walked points + the
   live leg's endpoint.
2. Path `window` = `[00:00:00, length]`, with `draw-in`/`draw-out`/
   `fade-in`/`fade-out` = 0, so the historical prefix is visible from frame 0.
3. `append: { from, window, easing }`:
   - `from` is the arc-length fraction up to the pin's start position.
   - `window` is the pin move's window.
   - `easing` matches the pin move (`linear` for constant walking speed).
4. The pin move starts at the append start coordinate, spans the same window,
   and ends at the trace's last coordinate. If the user gives a target the
   walkers do not reach, compute the reached coordinate from speed × duration
   along the bearing and use it for both the pin's `to-coord` and the trace's
   last coordinate.
5. Never author history + live leg as two path objects: each object restarts
   the dash phase, so the junction shows a seam. Do not set `draw-in` on an
   appended path; `append` owns the progress.

## Step 3: Half-framing geometry (authoring rule)

In half modes the camera `center` is the **strip's center**. The renderer
`jumpTo`s it on the 806×1080 (or 1920×454) map element with no offset, so the
visible strip is centered on it.

- `half-bottom`: strip is a latitude band around the center at the scene's
  end zoom. The interesting band must fit the 454 px strip.
- `half` / `half-right`: strip is a longitude band around the center. Keep
  the interesting content at or near the center. Long geometry (segments,
  exclusion edges) must overhang both strip edges so no cut edge shows inside
  the strip.
- Compute placements with Mercator math. The tile law is 512 px tiles:
  meters per pixel = 40,075,016 × cos(lat) / (512 × 2^zoom).
- Overlays (pins, labels, points) do not scale with zoom. Check both zoom
  extremes and both label sides.
- Self-verify with a probe render before the full render. Framing mistakes
  have shipped repeatedly; check the actual pixels.

## Step 4: Author and validate

Write `scenes/<project>-<nn>-<slug>.json` (slug = kebab-case, matches the
content). Then:

```sh
node scripts/validate-scene.mjs scenes/<file>.json
```

Zero errors required. Warnings are authoring nudges. Fix real ones (unknown
fields, geometry) and state which benign ones remain (for example intentional
co-window overlaps).

Station and line slugs must resolve against `data/geo/`. Look them up; never
guess a slug. If the scene uses only hand-authored coordinates, no geo data is
needed.

**As soon as the slug is fixed**, rename the current opencode session to
`Scene - {scene_slug}` with the `rename_session` tool. It knows its own session
ID and is safe with parallel sessions.

## Step 5: Render and self-review (mandatory; do not hand over before)

Render time scales with scene length (about 0.5-1 s per frame plus encode).
The bash tool kills a command after **120 s**, so render with the repo-local
`render` tool (`.opencode/tools/render.ts`; see the renders rule):

```
render({ scenes: ["scenes/<file>.json"] })
```

Several scenes render in parallel when passed together. A failed scene comes
back with the log tail.

Output lands flat in `./renders/` (`<stem>-<variant>.mov` plus
`render-log-<stem>-<variant>.json`) unless `MAP_RENDER_OUT` is set. The render
tool reveals the master in Finder on success. If you rendered through the
fallback, reveal it yourself:

```sh
open -R "renders/<stem>-<variant>.mov"
```

Then review the frames yourself:

```sh
ffmpeg -i <mov> -vf "select=eq(n\,<FRAME>)" -frames:v 1 /tmp/<name>-f<N>.png
```

Extract 4-6 frames across the timeline (0, mid, end, slide edges) and look at
them (downscale first; see the read-images rule). Check:

- start and end frames show what the user asked for;
- half framing covers exactly 42%, no transparent gaps inside the strip, the
  divider on the shared edge, top/left clean;
- elements appear and disappear at the right times;
- pin and label sizes read well at the final zoom;
- the last frame is not dissolved by a tail fade.

Fix and re-render until the frames match the brief. **Report what you saw in
the frames**, not just "rendered successfully".

## Step 6: Handover

Tell the user: file path, where the render landed, which frames you checked
and what they show, remaining validation warnings (if any), and the one or two
decisions they may want to change (camera timing, fade lengths).

## Step 7: Feedback triage (scene-specific vs general)

Feedback comes in two kinds. Sort every point before touching anything and say
the sort out loud in the reply:

- **Scene-specific**: about this scene's JSON: camera waypoints, windows,
  which stations or areas, zoom levels, element timing, overrides. Fix in the
  scene JSON directly; authoring is free, no gate.
- **General**: about every scene: pin size or color, label sizes, stripe
  metrics, divider look, ride flow, fade defaults, basemap tokens. These are
  frozen surfaces. Route through the **style-tokens** skill, edit the owning
  file only, re-render, and log the change.

A point can be both. When unsure, ask the user. When a scene fix would just
re-expose a general problem, name it.

## Style changes are gated

Any change to looks (pin size, colors, stripe metrics, divider) or recipe
defaults goes through the **style-tokens** skill. Never edit
`render/page/index.html`, `render/page/page.js`, or `recipes/recipes.json` as
part of scene authoring. Scene JSON (`overrides`, camera, windows) is free to
author.
