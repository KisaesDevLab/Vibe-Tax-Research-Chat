// TP-5a — the whitelist of fact paths a suggest rule may address (as
// `facts.<path>`; `[]` = the evaluator's some-element selector). Derived by
// hand from fact-schema.json 1.0.0 and drift-checked bidirectionally in
// fact-paths.test.ts — schema evolution that forgets this list fails
// `pnpm -r test`. Provenance `sources` nodes are deliberately absent:
// rules must never predicate on provenance.
export const FACT_PATHS: readonly string[] = [
  'entity.type',
  'entity.formationState',
  'entity.fiscalYearEnd',
  'entity.sCorpEffectiveDate',
  'entity.accountingMethod',
  'entity.notes',
  'ownership[]',
  'ownership[].owner',
  'ownership[].pct',
  'ownership[].role',
  'ownership[].relatedParty',
  'stateFootprint[]',
  'stateFootprint[].state',
  'stateFootprint[].nexusBasis',
  'stateFootprint[].ptetElected',
  'income.characters[]',
  'income.sources[]',
  'income.sources[].label',
  'income.sources[].character',
  'income.sources[].approxBand',
  'income.notes',
  'electionsInEffect[]',
  'electionsInEffect[].code',
  'electionsInEffect[].since',
  'electionsInEffect[].note',
  'carryforwards[]',
  'carryforwards[].type',
  'carryforwards[].amount',
  'carryforwards[].expires',
  'property[]',
  'property[].kind',
  'property[].description',
  'property[].placedInService',
  'property[].basis',
  'property[].method',
  'household.filingStatus',
  'household.dependents[]',
  'household.dependents[].ageBand',
  'household.dependents[].relationship',
  'lifeEvents[]',
  'lifeEvents[].year',
  'lifeEvents[].event',
  'lifeEvents[].note',
  'openQuestions[]',
  'openQuestions[].id',
  'openQuestions[].question',
  'openQuestions[].raisedBy',
  'openQuestions[].status',
  'narrative',
];

const PATH_SET = new Set(FACT_PATHS);

/** Accepts `facts.<whitelisted path>`. */
export function isValidFactField(field: string): boolean {
  if (!field.startsWith('facts.')) return false;
  return PATH_SET.has(field.slice('facts.'.length));
}
