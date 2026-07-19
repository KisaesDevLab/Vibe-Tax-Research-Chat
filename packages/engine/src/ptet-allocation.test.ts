// QA round 1 — PTET entity-deduction allocation. Only S corps and
// partnerships can elect PTET; the deduction must never shrink a
// Schedule C's SE base.
import { describe, it, expect } from 'vitest';
import { computeYear } from './compute-year.js';
import { EMPTY_CARRYFORWARD } from '@vibe/shared';
import { loadTables2026, baseProfile } from './test-fixtures.js';

const tables = loadTables2026();

describe('PTET deduction allocation', () => {
  it('leaves the Schedule C SE base untouched when an S corp pays PTET', () => {
    const mixed = baseProfile({
      filingStatus: 'mfj',
      businesses: [
        {
          id: 'c1',
          name: 'Sole prop',
          kind: 'schedule-c',
          netProfit: 300_000,
          employeeWages: 0,
          ownerWages: 0,
          sstb: false,
          qbiEligible: true,
        },
        {
          id: 's1',
          name: 'S corp',
          kind: 's-corp',
          netProfit: 100_000,
          employeeWages: 0,
          ownerWages: 40_000,
          sstb: false,
          qbiEligible: true,
        },
      ],
    });
    const withoutPtet = computeYear(mixed, tables, EMPTY_CARRYFORWARD, 2026);
    const withPtet = computeYear({ ...mixed, ptetPaid: 3_000 }, tables, EMPTY_CARRYFORWARD, 2026);
    // SE tax must be identical — the whole entity deduction lands on the
    // S corp flow, never the Schedule C.
    expect(withPtet.result.seTax).toBe(withoutPtet.result.seTax);
    // The FULL deduction lands on the S-corp flow: an exact delta, so a
    // regression to an all-positive-flows denominator (which would send
    // ~84% of the deduction nowhere) cannot pass.
    expect(withoutPtet.result.agi - withPtet.result.agi).toBe(3_000);
  });

  it('deepens the S-corp loss in a loss year instead of dropping the deduction', () => {
    const lossYear = baseProfile({
      filingStatus: 'mfj',
      state: { code: 'MO', flatRate: 0.05 },
      businesses: [
        {
          id: 'c1',
          name: 'Sole prop',
          kind: 'schedule-c',
          netProfit: 200_000,
          employeeWages: 0,
          ownerWages: 0,
          sstb: false,
          qbiEligible: true,
        },
        {
          id: 's1',
          name: 'S corp',
          kind: 's-corp',
          netProfit: -50_000,
          employeeWages: 0,
          ownerWages: 0,
          sstb: false,
          qbiEligible: true,
        },
      ],
    });
    const withoutPtet = computeYear(lossYear, tables, EMPTY_CARRYFORWARD, 2026);
    const withPtet = computeYear(
      { ...lossYear, ptetPaid: 10_000 },
      tables,
      EMPTY_CARRYFORWARD,
      2026,
    );
    // The entity deduction deepens the S-corp loss — AGI drops by the
    // full PTET amount, the Schedule C SE base is untouched, and the
    // model says so in a note.
    expect(withoutPtet.result.agi - withPtet.result.agi).toBe(10_000);
    expect(withPtet.result.seTax).toBe(withoutPtet.result.seTax);
    expect(withPtet.result.notes.join(' ')).toMatch(/deepens the pass-through loss/);
  });

  it('notes the unmodeled deduction when there is no electable entity at all', () => {
    const noEntity = baseProfile({
      filingStatus: 'mfj',
      wages: 150_000,
      ptetPaid: 5_000,
    });
    const { result } = computeYear(noEntity, tables, EMPTY_CARRYFORWARD, 2026);
    expect(result.notes.join(' ')).toMatch(/no S-corp\/partnership flow/);
    // Burden still carries the cash out the door.
    expect(result.totalBurden).toBeGreaterThan(0);
  });
});
