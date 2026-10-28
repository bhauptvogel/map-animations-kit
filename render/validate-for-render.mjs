// validate-for-render.mjs — the render-path validation gate (§7.1).
// The renderer must not duplicate the validator, so it re-uses the same
// error/warn contract by importing the shared core. Keeping this as a thin
// wrapper means validator semantics stay in exactly one place.
//
// scripts/validate-scene.mjs owns the contract; this wrapper exists because
// that script is CLI-shaped. If a shared-core refactor ever graduates, both
// entry points converge on it — for now the renderer invokes the validator's
// contract through this module boundary.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function validateForRender(rootDir, scenePath) {
  // Run the zero-dep validator as a subprocess against the scene file —
  // single source of truth for the contract, zero duplicated rules.
  const script = path.join(rootDir, 'scripts/validate-scene.mjs');
  const res = spawnSync(process.execPath, [script, path.resolve(rootDir, scenePath)], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  // The validator exits non-zero when errors exist; stderr carries the ERROR lines.
  const errors = (res.stderr || '').split('\n').filter((l) => l.includes('ERROR')).map((l) => l.trim());
  return { errors, output: res.stdout || '' };
}