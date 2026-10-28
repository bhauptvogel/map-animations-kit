---
name: style-tokens
description: Use when editing any frozen style token or recipe default in this repo (colors, stripe metrics, blink law, pin look, fades) or when the user gives visual feedback on a rendered clip. Gates the edit behind the single-source-of-truth rules and applies changes with a re-render.
---

# Style tokens and recipe edits: the gated edit flow

Every visual number lives in exactly one editable surface, and edit rights
differ per layer. "Frozen" means deliberate friction, not never touch: the
basemap look went through several prototype rounds because every change was a
conscious, re-rendered decision.

## The three edit surfaces

| Layer | File | Edit rights |
|---|---|---|
| Basemap and paint colors | `style/style.json`, renderer token constants in `render/page/page.js`, pin DOM in `render/page/index.html` | User feedback only; every change is a re-render |
| Motion and geometry numbers | `recipes/recipes.json` (normative) | User feedback only; edit the JSON, never the README's numbers |
| Scene-level motion | `scenes/*.json` (`overrides` at the Window carrier only) | Authoring, anytime; this layer is not frozen |

`recipes/README.md` documents semantics only. It deliberately repeats no
numbers, so the JSON and the README cannot drift. If they ever disagree, the
JSON wins; fix the README.

## Before editing: the gate

1. **Is it actually a frozen layer?** Scene overrides and the scene's own
   numbers need no gate. Only basemap tokens, recipe defaults, and
   renderer-constant look (pin DOM, stripe colors, label styling) go through
   this skill.
2. **Does the ask contradict a locked rule?** Locked: paint order, slug-only
   geo references, additive-only exclusions, two pins maximum, no rendered
   attribution or title cards, the easing library membership. A request inside
   these needs a spec conversation, not an edit.
3. **Is this a re-derivation?** The user's words ("a bit darker", "in the
   direction of travel") are direction, not values. Pick concrete numbers,
   state them in the reply, and let the next render verdict confirm. Do not
   re-derive a token from scratch or "improve" an untouched neighbor.
4. **Which surface owns it?** Colors go to `style.json` or renderer
   constants. Geometry and motion go to `recipes.json`. A number appearing in
   two places is a bug: single source of truth, always.

## Editing (after the gate passes)

1. Edit the owning file only.
2. Recipe edits: update `recipes/recipes.json`. Add a one-line note to
   `recipes/README.md` only if the semantics (not numbers) changed.
3. Renderer-constant edits: keep a comment pointing at the token table or the
   reason, and record the change in the project's design notes.
4. Re-render the affected scene(s). Aesthetic changes are only ever evaluated
   on real frames, using the repo `render` tool (see the renders rule).
5. Record the change (old to new, user words to concrete numbers) in the
   project's design notes or changelog.
