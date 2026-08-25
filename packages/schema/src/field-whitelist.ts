// TP-5a — the fifth validation gate: every suggest-rule leaf field must be
// a known profile field, a virtual aggregate, or a whitelisted facts.*
// path. Closes the silent-typo hole where resolveField returned undefined
// and the predicate quietly evaluated false forever.
import type { ValidStrategyRecord } from './strategy-record.js';
import type { ValidationError } from './types.js';
import { isValidFactField } from './fact-paths.js';

/** Mirrors BaselineProfile (packages/shared/src/types/planning.ts) plus the
 *  `.length` idioms rules already use. */
export const PROFILE_FIELDS: readonly string[] = [
  'filingStatus',
  'state',
  'state.code',
  'state.flatRate',
  'wages',
  'businesses.length',
  'rentals.length',
  'interestIncome',
  'ordinaryDividends',
  'qualifiedDividends',
  'shortTermCapGain',
  'longTermCapGain',
  'otherIncome',
  'adjustments',
  'seHealthInsurance',
  'retirementContributions',
  'hsaContribution',
  'itemized.stateLocalTaxesPaid',
  'itemized.mortgageInterest',
  'itemized.charitable',
  'itemized.other',
  'dependentsUnder17',
  'otherDependents',
  'withholding',
  'estimatedPayments',
  'qbiReduction',
  'otherCredits',
  'corpTaxPaid',
  'otherTaxes',
  'ptetPaid',
];

/** resolveField's hard-coded aggregates (packages/shared suggest.ts). */
export const VIRTUAL_FIELDS: readonly string[] = [
  'totalBusinessProfit',
  'hasBusiness',
  'hasScheduleC',
  'hasSCorp',
  'hasEntity',
  'hasRental',
  'hasEmployees',
];

const KNOWN = new Set([...PROFILE_FIELDS, ...VIRTUAL_FIELDS]);

export function isValidSuggestField(field: string): boolean {
  return KNOWN.has(field) || isValidFactField(field);
}

interface LeafLike {
  field?: unknown;
}
type NodeLike = LeafLike & { all?: NodeLike[]; any?: NodeLike[]; not?: NodeLike };

function walk(node: NodeLike, path: string, errs: ValidationError[]): void {
  if (Array.isArray(node.all)) {
    node.all.forEach((n, i) => walk(n, `${path}.all[${i}]`, errs));
    return;
  }
  if (Array.isArray(node.any)) {
    node.any.forEach((n, i) => walk(n, `${path}.any[${i}]`, errs));
    return;
  }
  if (node.not) {
    walk(node.not, `${path}.not`, errs);
    return;
  }
  if (typeof node.field === 'string' && !isValidSuggestField(node.field)) {
    errs.push({
      gate: 'completeness',
      path: `${path}.field`,
      message: `unknown suggest field "${node.field}" — not a profile field, virtual aggregate, or whitelisted facts.* path`,
    });
  }
}

export function checkSuggestFields(record: ValidStrategyRecord): ValidationError[] {
  const errs: ValidationError[] = [];
  const suggest = (record.modeled ? record.model?.suggest : record.suggest) as NodeLike | undefined;
  if (!suggest) return errs;
  walk(suggest, 'suggest', errs);
  return errs;
}
