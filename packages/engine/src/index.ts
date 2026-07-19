// TP-4 — public surface of @vibe/engine. Pure functions only; every
// constant is injected via TableSetPayload. Bump ENGINE_VERSION on any
// math change (plans pin it).
export const ENGINE_VERSION = '1.0.0';

export { computeYear, type ComputeYearOutput } from './compute-year.js';
export { dollars, toDollars, mulRate, clampMin0 } from './money.js';
export { netCapital } from './modules/capital.js';
export {
  computeSeTax,
  computeAdditionalMedicare,
  computeOwnerPayrollTax,
} from './modules/se-tax.js';
export { computePassive } from './modules/passive.js';
export { computeQbiDeduction, type QbiBusiness } from './modules/qbi.js';
export { computeDeduction, computeSaltCap } from './modules/deductions.js';
export { taxFromBrackets, taxPreferential } from './modules/brackets.js';
export { computeCtc } from './modules/credits.js';
