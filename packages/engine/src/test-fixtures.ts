// TP-4 — shared test fixtures: the TABLES_2026 seed payload (single
// source of truth in packages/db/seeds) and a baseline-profile factory.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { BaselineProfile, TableSetPayload } from '@vibe/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadTables2026(): TableSetPayload {
  const file = path.resolve(__dirname, '../../db/seeds/table-sets/2026.json');
  return (JSON.parse(readFileSync(file, 'utf-8')) as { payload: TableSetPayload }).payload;
}

export function baseProfile(overrides: Partial<BaselineProfile> = {}): BaselineProfile {
  return {
    filingStatus: 'single',
    state: null,
    wages: 0,
    businesses: [],
    rentals: [],
    interestIncome: 0,
    ordinaryDividends: 0,
    qualifiedDividends: 0,
    shortTermCapGain: 0,
    longTermCapGain: 0,
    otherIncome: 0,
    adjustments: 0,
    seHealthInsurance: 0,
    retirementContributions: 0,
    hsaContribution: 0,
    itemized: { stateLocalTaxesPaid: 0, mortgageInterest: 0, charitable: 0, other: 0 },
    dependentsUnder17: 0,
    otherDependents: 0,
    withholding: 0,
    estimatedPayments: 0,
    qbiReduction: 0,
    otherCredits: 0,
    corpTaxPaid: 0,
    otherTaxes: 0,
    ptetPaid: 0,
    ...overrides,
  };
}
