// TP-12 — @vibe/schema: the strategy-record validation gates
// (docs/strategy-schema.md §"Validation gates"). Order matters: shape
// first (zod), then citations, prose, and completeness — the later
// gates assume a structurally valid record.
import { strategyRecordSchema, type ValidStrategyRecord } from './strategy-record.js';
import { lintCitations } from './citation-lint.js';
import { checkProse } from './prose.js';
import { checkCompleteness } from './completeness.js';
import { checkSuggestFields } from './field-whitelist.js';
import type { ValidationError, ValidationResult } from './types.js';

export * from './types.js';
export {
  strategyRecordSchema,
  CATEGORIES,
  SAVINGS_BANDS,
  ENTITY_TYPES,
  APPLY_ORDER_MIN,
  APPLY_ORDER_MAX,
  type ValidStrategyRecord,
} from './strategy-record.js';
export { lintCitation, lintCitations } from './citation-lint.js';
export {
  factSourceSchema,
  factPatternSchema,
  validateFactPattern,
  factCandidateEmitSchema,
  factCandidateSchema,
  type FactCandidateEmit,
} from './fact-pattern.js';
export { fleschKincaidGrade, checkProse, BANNED_WORDS, MAX_CLIENT_GRADE } from './prose.js';
export { checkCompleteness } from './completeness.js';
export { FACT_PATHS, isValidFactField } from './fact-paths.js';
export {
  PROFILE_FIELDS,
  VIRTUAL_FIELDS,
  isValidSuggestField,
  checkSuggestFields,
} from './field-whitelist.js';

/** Run every gate against an untrusted record. */
export function validateStrategyRecord(record: unknown): ValidationResult {
  const parsed = strategyRecordSchema.safeParse(record);
  if (!parsed.success) {
    const errors: ValidationError[] = parsed.error.issues.map((issue) => ({
      gate: 'schema',
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return { ok: false, errors };
  }
  const valid: ValidStrategyRecord = parsed.data;
  const errors: ValidationError[] = [
    ...lintCitations(valid),
    ...checkProse(valid),
    ...checkCompleteness(valid),
    ...checkSuggestFields(valid),
  ];
  return { ok: errors.length === 0, errors };
}
