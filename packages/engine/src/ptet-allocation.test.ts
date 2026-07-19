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
    // The deduction still reduces AGI (through the S-corp flow).
    expect(withPtet.result.agi).toBeLessThan(withoutPtet.result.agi);
  });
});
