// TP-5 — the apply-module registry. Static map from `id@semver` to a
// compiled TypeScript function; content rows reference these by
// apply_module_ref. No dynamic import, no eval — an unknown ref is a
// hard error at compute time (never a silent no-op).
import type { ApplyFn } from './types.js';
import { MODULES } from './modules/index.js';

export function resolveApply(ref: string): ApplyFn {
  const fn = MODULES[ref];
  if (!fn) {
    throw new Error(
      `Unknown apply module ref "${ref}" — the strategy content references math that is not compiled into this build.`,
    );
  }
  return fn;
}

export function listModuleRefs(): string[] {
  return Object.keys(MODULES).sort();
}
