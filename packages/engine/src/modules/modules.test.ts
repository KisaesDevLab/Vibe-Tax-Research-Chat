// TP-4 — module-level unit tests (pure helpers, cents in/out).
import { describe, it, expect } from 'vitest';
import { dollars } from '../money.js';
import { taxFromBrackets, taxPreferential } from './brackets.js';
import { netCapital } from './capital.js';
import { computeSeTax, computeOwnerPayrollTax } from './se-tax.js';
import { computeSaltCap } from './deductions.js';
import { loadTables2026 } from '../test-fixtures.js';

const T = loadTables2026();

describe('taxFromBrackets', () => {
  it('zero and negative taxable → zero tax', () => {
    expect(taxFromBrackets(0, T.brackets.single)).toBe(0);
    expect(taxFromBrackets(-100, T.brackets.single)).toBe(0);
  });

  it('exactly at a bracket ceiling', () => {
    // Single 12,400 → 10% flat = 1,240.
    expect(taxFromBrackets(dollars(12_400), T.brackets.single)).toBe(dollars(1_240));
  });

  it('top bracket applies above the last ceiling', () => {
    // Single 1,000,000: through the table then 37% on the excess over 640,600.
    // 1,240 + 4,560 + 12,166 + 23,058 + 17,424 + 134,531.25 + 132,978
    const tax = taxFromBrackets(dollars(1_000_000), T.brackets.single);
    // 10%×12,400=1,240; 12%×38,000=4,560; 22%×55,300=12,166;
    // 24%×96,075=23,058; 32%×54,450=17,424; 35%×384,375=134,531.25;
    // 37%×359,400=132,978 → total 325,957.25.
    expect(tax).toBe(Math.round(325_957.25 * 100));
  });
});

describe('taxPreferential', () => {
  it('all inside the 0% band is free', () => {
    expect(taxPreferential(dollars(10_000), dollars(20_000), T.capitalGainsBrackets.single)).toBe(
      0,
    );
  });

  it('stacking starts where ordinary income ends', () => {
    // Ordinary 545,000, pref 10,000 (single): 500 at 15% (to 545,500), 9,500 at 20%.
    const tax = taxPreferential(dollars(10_000), dollars(545_000), T.capitalGainsBrackets.single);
    expect(tax).toBe(dollars(500 * 0.15 + 9_500 * 0.2));
  });
});

describe('netCapital', () => {
  it('pure LT gain is preferential', () => {
    const r = netCapital(0, dollars(10_000), 0);
    expect(r.preferentialGain).toBe(dollars(10_000));
    expect(r.ordinaryComponent).toBe(0);
  });

  it('pure ST gain is ordinary', () => {
    const r = netCapital(dollars(10_000), 0, 0);
    expect(r.ordinaryComponent).toBe(dollars(10_000));
    expect(r.preferentialGain).toBe(0);
  });

  it('loss beyond $3,000 carries forward', () => {
    const r = netCapital(dollars(-8_000), 0, 0);
    expect(r.ordinaryComponent).toBe(dollars(-3_000));
    expect(r.carryforwardOut).toBe(dollars(5_000));
  });

  it('LT loss nets against ST gain', () => {
    const r = netCapital(dollars(10_000), dollars(-4_000), 0);
    expect(r.ordinaryComponent).toBe(dollars(6_000));
    expect(r.preferentialGain).toBe(0);
  });
});

describe('computeSeTax coordination', () => {
  it('no SE income → zero', () => {
    expect(computeSeTax(0, 0, T.seTax).seTax).toBe(0);
  });

  it('W-2 wages above the base zero out the SS portion', () => {
    const r = computeSeTax(dollars(50_000), dollars(190_000), T.seTax);
    // Medicare only: 46,175 × 2.9% = 1,339.075 → 133,908 cents.
    expect(r.seTax).toBe(133_908);
  });
});

describe('computeOwnerPayrollTax', () => {
  it('both halves on owner wages under the base', () => {
    const r = computeOwnerPayrollTax(dollars(100_000), 0, T.seTax);
    expect(r.total).toBe(dollars(15_300));
    expect(r.employerHalf).toBe(dollars(7_650));
  });

  it('SS capped by the remaining base after outside wages', () => {
    const r = computeOwnerPayrollTax(dollars(100_000), dollars(150_000), T.seTax);
    // Remaining base 34,500 → SS 4,278; Medicare 2,900 → 7,178.
    expect(r.total).toBe(dollars(7_178));
  });
});

describe('computeSaltCap', () => {
  it('full cap below the threshold', () => {
    expect(computeSaltCap(dollars(300_000), 'mfj', T.salt)).toBe(dollars(40_400));
  });
  it('linear phase-down', () => {
    expect(computeSaltCap(dollars(600_000), 'mfj', T.salt)).toBe(dollars(11_900));
  });
  it('floor holds', () => {
    expect(computeSaltCap(dollars(2_000_000), 'mfj', T.salt)).toBe(dollars(10_000));
  });
});
