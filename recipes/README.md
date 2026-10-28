# recipes/

`recipes.json` is the normative recipe book: every named motion or styling law,
its parameter names, types, defaults and enum values. Scenes reference recipe
names; per-scene deviations go through an `overrides` object at the element
that carries the Window.

`scripts/validate-scene.mjs` reads this file: unknown recipe names and unknown
override keys are errors. The renderer imports the same file for defaults.
Nothing else in the pipeline hardcodes these numbers.

Semantics, the override table, the easing library and the fade law are in
[`../docs/RECIPES.md`](../docs/RECIPES.md). That document deliberately repeats
no numbers, so it cannot drift from the JSON.

Recipe changes are a frozen surface: route them through the style-tokens skill
and re-render the affected scenes.
