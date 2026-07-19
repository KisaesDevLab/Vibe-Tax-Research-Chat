// QA round 1 — multi-year projection semantics. The golden suite runs
// years:1, which is exactly why one-shot re-application and NOL
// non-depletion survived it. These tests pin the year-2+ behavior.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeScenario } from '@vibe/engine';
import type { BaselineProfile, TableSetPayload } from '@vibe/shared';
import { resolveApply } from './registry.js';
import './index.js'; // registers all apply modules

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tables = (
  JSON.parse(
    readFileSync(path.resolve(__dirname, '../../db/seeds/table-sets/2026.json'), 'utf-8'),
  ) as { payload: TableSetPayload }
).payload;

const base = (over: Partial<BaselineProfile> = {}): BaselineProfile => ({
  filingStatus: 'mfj',
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
  ...over,
});

const schC = (netProfit: number) => ({
  id: 'b1',
  name: 'Business',
  kind: 'schedule-c' as const,
  netProfit,
  employeeWages: 0,
  ownerWages: 0,
  sstb: false,
  qbiEligible: true,
});

function run(
  strategyId: string,
  applyOrder: number,
  params: Record<string, unknown>,
  profile: BaselineProfile,
  years: number,
) {
  const scenario = composeScenario({
    baseline: profile,
    transforms: [{ strategyId, applyOrder, params, apply: resolveApply(`${strategyId}@1.0.0`) }],
    years,
    growthPct: 0,
    tableSet: tables,
    startYear: 2026,
  });
  const baseline = composeScenario({
    baseline: profile,
    transforms: [],
    years,
    growthPct: 0,
    tableSet: tables,
    startYear: 2026,
  });
  return scenario.years.map((y, i) => y.totalBurden - baseline.years[i]!.totalBurden);
}

describe('one-shot deductions act in year one only', () => {
  it('daf-bunching deducts once, later years match baseline', () => {
    const deltas = run(
      'daf-bunching',
      40,
      { contribution: 60_000 },
      base({
        wages: 250_000,
        itemized: {
          stateLocalTaxesPaid: 10_000,
          mortgageInterest: 12_000,
          charitable: 8_000,
          other: 0,
        },
      }),
      3,
    );
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[1]).toBe(0);
    expect(deltas[2]).toBe(0);
  });

  it('heavy-vehicle-179 expenses once', () => {
    const deltas = run(
      'heavy-vehicle-179',
      36,
      { vehicleCost: 90_000, businessUsePct: 100 },
      base({ businesses: [schC(300_000)] }),
      3,
    );
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[1]).toBe(0);
    expect(deltas[2]).toBe(0);
  });

  it('section-179-expensing elects once', () => {
    const deltas = run(
      'section-179-expensing',
      36,
      { electedAmount: 60_000 },
      base({ businesses: [schC(300_000)] }),
      2,
    );
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[1]).toBe(0);
  });
});

describe('nol-planning depletes the carryforward across years', () => {
  it('a 500k NOL against ~300k income runs dry, then stops deducting', () => {
    const deltas = run(
      'nol-planning',
      64,
      { nolCarryforward: 500_000 },
      base({ businesses: [schC(300_000)] }),
      4,
    );
    // Years 1-2 take the 80% bite; year 3 takes the remainder; year 4
    // must be exactly baseline — the NOL is gone.
    expect(deltas[0]!).toBeLessThan(-10_000);
    expect(deltas[1]!).toBeLessThan(-10_000);
    expect(deltas[2]!).toBeLessThan(0);
    expect(Math.abs(deltas[2]!)).toBeLessThan(Math.abs(deltas[1]!));
    expect(deltas[3]).toBe(0);
  });
});

describe('bracket-management threads the timing move across years', () => {
  it('steady-state deferral saves in year 1 only; later years net to baseline', () => {
    const deltas = run(
      'bracket-management',
      64,
      { deferAmount: 50_000 },
      base({ otherIncome: 200_000 }),
      3,
    );
    // Year 1 defers 50k out. Year 2+ receives the prior deferral back
    // while deferring anew — net zero, NOT a fresh 50k exclusion.
    expect(deltas[0]!).toBeLessThan(-5_000);
    expect(deltas[1]).toBe(0);
    expect(deltas[2]).toBe(0);
  });

  it('acceleration costs in year 1 and nets to baseline afterward', () => {
    const deltas = run(
      'bracket-management',
      64,
      { deferAmount: -30_000 },
      base({ otherIncome: 100_000 }),
      3,
    );
    expect(deltas[0]!).toBeGreaterThan(0);
    expect(deltas[1]).toBe(0);
    expect(deltas[2]).toBe(0);
  });
});

describe('recurring strategies still apply every year', () => {
  it('meals-optimization (an annual practice) reduces every year', () => {
    const deltas = run(
      'meals-optimization',
      34,
      { additionalDeduction: 6_000 },
      base({ businesses: [schC(300_000)] }),
      3,
    );
    for (const d of deltas) expect(d).toBeLessThan(0);
  });
});
