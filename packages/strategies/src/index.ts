// TP-5 — public surface of @vibe/strategies.
// Side-effect import registers the TP-6 apply modules into MODULES.
import './modules/tp6-modules.js';

export type { ApplyContext, ApplyResult, ApplyFn, StrategyRecord } from './types.js';
export { resolveApply, listModuleRefs } from './registry.js';
export { listStrategyRecords } from './content.js';
export { MODULES } from './modules/index.js';
