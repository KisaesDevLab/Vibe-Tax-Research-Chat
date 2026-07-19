// TP-5 — scenario composition tests: hand cases + fast-check properties
// (input order never matters; empty scenario === baseline).
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { composeScenario, type ScenarioTransform } from './scenario.js';
import { computeYear } from './compute-year.js';
import { EMPTY_CARRYFORWARD, type BaselineProfile } from '@vibe/shared';
import { loadTables2026, baseProfile } from './test-fixtures.js';

const T = loadTables2026();

const addAdjustment = (id: string, order: number, amount: number): ScenarioTransform => ({
  strategyId: id,
  applyOrder: order,
  params: {},
  apply: ({ profile }) => ({
    profile: { ...profile, adjustments: profile.adjustments + amount },
  }),
});

describe('composeScenario', () => {
  it('empty scenario equals the baseline year-by-year', () => {
    const p = baseProfile({ filingStatus: 'mfj', wages: 200_000 });
    const scenario = composeScenario({
      baseline: p,
      transforms: [],
      years: 3,
      growthPct: 0,
      tableSet: T,
      startYear: 2026,
    });
    const direct = computeYear(p, T, EMPTY_CARRYFORWARD, 2026).result;
    expect(scenario.years[0]).toEqual(direct);
    expect(scenario.years).toHaveLength(3);
  });

  it('growth compounds on income fields', () => {
    const p = baseProfile({ wages: 100_000 });
    const s = composeScenario({
      baseline: p,
      transforms: [],
      years: 3,
      growthPct: 10,
      tableSet: T,
      startYear: 2026,
    });
    expect(s.years[0]!.agi).toBe(100_000);
    expect(s.years[1]!.agi).toBe(110_000);
    expect(s.years[2]!.agi).toBe(121_000);
  });

  it('projection years zero the payments', () => {
    const p = baseProfile({ wages: 100_000, withholding: 15_000 });
    const s = composeScenario({
      baseline: p,
      transforms: [],
      years: 2,
      growthPct: 0,
      tableSet: T,
      startYear: 2026,
    });
    expect(s.years[0]!.payments).toBe(15_000);
    expect(s.years[1]!.payments).toBe(0);
  });

  it('transforms run in applyOrder with id tiebreak and are labeled in notes', () => {
    const seen: string[] = [];
    const track = (id: string, order: number): ScenarioTransform => ({
      strategyId: id,
      applyOrder: order,
      params: {},
      apply: ({ profile }) => {
        seen.push(id);
        return { profile, notes: ['ran'] };
      },
    });
    const s = composeScenario({
      baseline: baseProfile({ wages: 50_000 }),
      transforms: [track('zeta', 30), track('alpha', 30), track('early', 10)],
      years: 1,
      growthPct: 0,
      tableSet: T,
      startYear: 2026,
    });
    expect(seen).toEqual(['early', 'alpha', 'zeta']);
    expect(s.notes).toEqual(['[early y1] ran', '[alpha y1] ran', '[zeta y1] ran']);
  });

  it('per-strategy carry threads across years', () => {
    const carryCounter: ScenarioTransform = {
      strategyId: 'counter',
      applyOrder: 30,
      params: {},
      apply: ({ profile, carry }) => {
        const n = ((carry.n as number) ?? 0) + 1;
        return {
          profile: { ...profile, adjustments: profile.adjustments + n * 1000 },
          carryPatch: { n },
        };
      },
    };
    const s = composeScenario({
      baseline: baseProfile({ wages: 100_000 }),
      transforms: [carryCounter],
      years: 3,
      growthPct: 0,
      tableSet: T,
      startYear: 2026,
    });
    // Year 1: −1,000; year 2: −2,000; year 3: −3,000.
    expect(s.years.map((y) => y.agi)).toEqual([99_000, 98_000, 97_000]);
  });

  it('property: transform input order never changes results', () => {
    fc.assert(
      fc.property(
        fc.record({
          wages: fc.integer({ min: 0, max: 500_000 }),
          adj1: fc.integer({ min: 0, max: 20_000 }),
          adj2: fc.integer({ min: 0, max: 20_000 }),
          order1: fc.constantFrom(10, 30, 50, 80),
          order2: fc.constantFrom(10, 30, 50, 80),
        }),
        ({ wages, adj1, adj2, order1, order2 }) => {
          const p = baseProfile({ wages });
          const a = addAdjustment('strategy-a', order1, adj1);
          const b = addAdjustment('strategy-b', order2, adj2);
          const forward = composeScenario({
            baseline: p,
            transforms: [a, b],
            years: 2,
            growthPct: 3,
            tableSet: T,
            startYear: 2026,
          });
          const reversed = composeScenario({
            baseline: p,
            transforms: [b, a],
            years: 2,
            growthPct: 3,
            tableSet: T,
            startYear: 2026,
          });
          expect(forward.years).toEqual(reversed.years);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: empty scenario === baseline for arbitrary simple profiles', () => {
    fc.assert(
      fc.property(
        fc.record({
          wages: fc.integer({ min: 0, max: 1_000_000 }),
          interestIncome: fc.integer({ min: 0, max: 100_000 }),
          longTermCapGain: fc.integer({ min: -50_000, max: 200_000 }),
          filingStatus: fc.constantFrom(
            'single' as const,
            'mfj' as const,
            'mfs' as const,
            'hoh' as const,
          ),
        }),
        (r) => {
          const p: BaselineProfile = baseProfile({
            wages: r.wages,
            interestIncome: r.interestIncome,
            longTermCapGain: r.longTermCapGain,
            filingStatus: r.filingStatus,
          });
          const viaScenario = composeScenario({
            baseline: p,
            transforms: [],
            years: 1,
            growthPct: 0,
            tableSet: T,
            startYear: 2026,
          }).years[0];
          const direct = computeYear(p, T, EMPTY_CARRYFORWARD, 2026).result;
          expect(viaScenario).toEqual(direct);
        },
      ),
      { numRuns: 50 },
    );
  });
});
