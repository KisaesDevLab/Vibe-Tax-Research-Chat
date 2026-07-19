// TP-5 — module manifest. TP-6 fills the first 10; TP-12 adds the
// factory-parameterized remainder. Keys are `id@semver`.
import type { ApplyFn } from '../types.js';

export const MODULES: Record<string, ApplyFn> = {};

export function register(ref: string, fn: ApplyFn): void {
  MODULES[ref] = fn;
}
