// TP-4 — integration checkpoints for computeYear against TABLES_2026.
// Every expected figure is hand-computed in the comment above its assert.
import { describe, it, expect } from 'vitest';
import { computeYear } from './compute-year.js';
import { EMPTY_CARRYFORWARD } from '@vibe/shared';
import { loadTables2026, baseProfile } from './test-fixtures.js';

const T = loadTables2026();
const run = (p: ReturnType<typeof baseProfile>, carry = EMPTY_CARRYFORWARD) =>
  computeYear(p, T, carry, 2026);

describe('computeYear — W-2 baselines', () => {
  it('MFJ, wages 200k, standard deduction', () => {
    const { result } = run(baseProfile({ filingStatus: 'mfj', wages: 200_000 }));
    // TI = 200,000 − 32,200 = 167,800.
    expect(result.taxableIncome).toBe(167_800);
    // 10%×24,800 + 12%×76,000 + 22%×67,000 = 2,480 + 9,120 + 14,740 = 26,340.
    expect(result.incomeTax).toBe(26_340);
    expect(result.seTax).toBe(0);
    expect(result.additionalMedicare).toBe(0);
    expect(result.niit).toBe(0);
    expect(result.totalBurden).toBe(26_340);
  });

  it('single, wages 50k — bottom brackets only', () => {
    const { result } = run(baseProfile({ wages: 50_000 }));
    // TI = 50,000 − 16,100 = 33,900. 10%×12,400 + 12%×21,500 = 1,240 + 2,580 = 3,820.
    expect(result.taxableIncome).toBe(33_900);
    expect(result.incomeTax).toBe(3_820);
  });

  it('single, wages 250k — additional Medicare kicks in', () => {
    const { result } = run(baseProfile({ wages: 250_000 }));
    // (250,000 − 200,000) × 0.9% = 450.
    expect(result.additionalMedicare).toBe(450);
  });

  it('payments produce balance due', () => {
    const { result } = run(
      baseProfile({ filingStatus: 'mfj', wages: 200_000, withholding: 20_000 }),
    );
    expect(result.payments).toBe(20_000);
    expect(result.balanceDue).toBe(26_340 - 20_000);
  });
});

describe('computeYear — Schedule C + SE + QBI', () => {
  it('single, Sch C 100k: SE tax, ½ deduction, QBI capped at 20% of TI', () => {
    const { result } = run(
      baseProfile({
        businesses: [
          {
            id: 'b1',
            name: 'Consulting',
            kind: 'schedule-c',
            netProfit: 100_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: false,
            qbiEligible: true,
          },
        ],
      }),
    );
    // Net earnings 92,350; SS 11,451.40 + Medicare 2,678.15 = 14,129.55 → 14,130.
    expect(result.seTax).toBe(14_130);
    expect(result.seTaxDeduction).toBe(7_065); // 7,064.78 rounded
    // AGI = 100,000 − 7,064.78 = 92,935.22 → 92,935.
    expect(result.agi).toBe(92_935);
    // TI before QBI = 76,835.22; QBI ded = min(20%×92,935.22, 20%×76,835.22)
    // = 15,367.04 → 15,367.
    expect(result.qbiDeduction).toBe(15_367);
    // TI = 61,468.18 → 61,468. Tax = 1,240 + 4,560 + 22%×11,068.18(=2,435) = 8,235.
    expect(result.taxableIncome).toBe(61_468);
    expect(result.incomeTax).toBe(8_235);
  });

  it('SS wage-base coordination: 150k W-2 + 100k Sch C', () => {
    const { result } = run(
      baseProfile({
        wages: 150_000,
        businesses: [
          {
            id: 'b1',
            name: 'Side biz',
            kind: 'schedule-c',
            netProfit: 100_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: false,
            qbiEligible: true,
          },
        ],
      }),
    );
    // Remaining base 34,500 → SS 4,278.00; Medicare on 92,350 = 2,678.15.
    // SE tax 6,956.15 → 6,956.
    expect(result.seTax).toBe(6_956);
    // Addl Medicare: 150,000 + 92,350 − 200,000 = 42,350 × 0.9% = 381.15 → 381.
    expect(result.additionalMedicare).toBe(381);
  });

  it('SE income fully above the wage base pays Medicare only on the excess', () => {
    const { result } = run(
      baseProfile({
        wages: 200_000,
        businesses: [
          {
            id: 'b1',
            name: 'Biz',
            kind: 'schedule-c',
            netProfit: 50_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: false,
            qbiEligible: true,
          },
        ],
      }),
    );
    // W-2 wages 200,000 ≥ base 184,500 → SS portion 0.
    // Medicare 46,175 × 2.9% = 1,339.075 → 1,339.08 → 1,339.
    expect(result.seTax).toBe(1_339);
  });

  it('SSTB fully phased out above the range', () => {
    const { result } = run(
      baseProfile({
        businesses: [
          {
            id: 'b1',
            name: 'Law firm',
            kind: 'schedule-c',
            netProfit: 400_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: true,
            qbiEligible: true,
          },
        ],
      }),
    );
    // TI before QBI far above 201,750 + 75,000 → SSTB deduction fully gone,
    // but the OBBBA minimum ($400) still applies to active QBI ≥ $1,000.
    expect(result.qbiDeduction).toBe(400);
  });

  it('SSTB partially phased in the range is between 0 and the full 20%', () => {
    const { result: mid } = run(
      baseProfile({
        businesses: [
          {
            id: 'b1',
            name: 'Practice',
            kind: 'schedule-c',
            netProfit: 260_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: true,
            qbiEligible: true,
          },
        ],
      }),
    );
    expect(mid.qbiDeduction).toBeGreaterThan(400);
    // Full 20% of QBI would be ≈ 20% × (260,000 − reductions) ≈ 48k.
    expect(mid.qbiDeduction).toBeLessThan(48_000);
  });

  it('non-SSTB above threshold with zero W-2 wages loses the deduction to the wage limit', () => {
    const { result } = run(
      baseProfile({
        businesses: [
          {
            id: 'b1',
            name: 'No-wage biz',
            kind: 'schedule-c',
            netProfit: 400_000,
            employeeWages: 0,
            ownerWages: 0,
            sstb: false,
            qbiEligible: true,
          },
        ],
      }),
    );
    // Above the phase-in top the 50%-of-W-2-wages limit binds fully: wages 0
    // → limit 0 → only the OBBBA minimum survives.
    expect(result.qbiDeduction).toBe(400);
  });

  it('non-SSTB above threshold WITH W-2 wages keeps the wage-limited amount', () => {
    const { result } = run(
      baseProfile({
        businesses: [
          {
            id: 'b1',
            name: 'Wage-paying biz',
            kind: 'schedule-c',
            netProfit: 400_000,
            employeeWages: 150_000,
            ownerWages: 0,
            sstb: false,
            qbiEligible: true,
          },
        ],
      }),
    );
    // Wage limit = 50% × 150,000 = 75,000 ≥ tentative — not binding;
    // deduction ≈ 20% of (400,000 − SE-level reductions), well above 400.
    expect(result.qbiDeduction).toBeGreaterThan(60_000);
  });
});

describe('computeYear — S-corp owner wages + PTET', () => {
  const sCorp = (over: Partial<Parameters<typeof baseProfile>[0]> = {}) =>
    baseProfile({
      filingStatus: 'mfj',
      state: { code: 'XX', flatRate: 0.05 },
      businesses: [
        {
          id: 's1',
          name: 'S corp',
          kind: 's-corp',
          netProfit: 300_000,
          employeeWages: 0,
          ownerWages: 100_000,
          sstb: false,
          qbiEligible: true,
        },
      ],
      ...over,
    });

  it('owner payroll tax both halves; employer half reduces flow-through', () => {
    const { result } = run(sCorp());
    // SS 12,400 + Medicare 2,900 = 15,300.
    expect(result.ownerPayrollTax).toBe(15_300);
    expect(result.seTax).toBe(0); // S-corp flow-through is not SE income
    // AGI = 100,000 wages + (300,000 − 100,000 − 7,650) = 292,350.
    expect(result.agi).toBe(292_350);
  });

  it('PTET is an entity deduction plus a state credit', () => {
    const withPtet = run(sCorp({ ptetPaid: 10_000 })).result;
    const without = run(sCorp()).result;
    // Flow-through drops by the PTET paid → AGI down 10,000.
    expect(without.agi - withPtet.agi).toBe(10_000);
    // State: 5% × AGI − credit.
    // gross = 5% × 282,350 = 14,117.50 → credit 10,000 → 4,117.50 → 4,118.
    expect(withPtet.ptetCredit).toBe(10_000);
    expect(withPtet.stateTax).toBe(4_118);
    // Without PTET: 5% × 292,350 = 14,617.50 → 14,618.
    expect(without.stateTax).toBe(14_618);
  });
});

describe('computeYear — capital gains, NIIT, stacking', () => {
  it('MFJ investment mix: NIIT on the MAGI excess, preferential stacking', () => {
    const { result } = run(
      baseProfile({
        filingStatus: 'mfj',
        wages: 200_000,
        interestIncome: 20_000,
        longTermCapGain: 50_000,
        qualifiedDividends: 10_000,
      }),
    );
    // AGI 280,000; NII 80,000; excess 30,000 → NIIT 1,140.
    expect(result.niit).toBe(1_140);
    // TI 247,800; pref 60,000; ordinary 187,800 → 2,480+9,120+19,140=30,740.
    expect(result.ordinaryTax).toBe(30_740);
    // Pref stacks 187,800→247,800, all inside the 15% band (98,900–613,700):
    // 60,000 × 15% = 9,000.
    expect(result.capitalGainsTax).toBe(9_000);
  });

  it('LTCG spanning the 0% break is taxed only above it', () => {
    const { result } = run(baseProfile({ wages: 46_100, longTermCapGain: 40_000 }));
    // Ordinary TI = 46,100 − 16,100 = 30,000. Pref layer 30,000→70,000:
    // 0% to 49,450 (19,450), 15% on 20,550 = 3,082.50 → 3,083.
    expect(result.capitalGainsTax).toBe(3_083);
  });

  it('net capital loss is limited to $3,000 with carryforward', () => {
    const { result, carryOut } = run(baseProfile({ wages: 100_000, shortTermCapGain: -10_000 }));
    // AGI = 100,000 − 3,000 = 97,000.
    expect(result.agi).toBe(97_000);
    expect(carryOut.capitalLossCarryforward).toBe(7_000);
  });

  it('carryforward from a prior year offsets current LTCG', () => {
    const { result } = run(baseProfile({ wages: 100_000, longTermCapGain: 5_000 }), {
      passiveByActivity: {},
      capitalLossCarryforward: 7_000,
    });
    // 5,000 − 7,000 = −2,000 → all allowed against ordinary.
    expect(result.agi).toBe(98_000);
  });

  it('ST losses net against LT gains before preferential treatment', () => {
    const { result } = run(
      baseProfile({ wages: 100_000, shortTermCapGain: -10_000, longTermCapGain: 30_000 }),
    );
    // Pref gain = 20,000; AGI = 120,000.
    expect(result.agi).toBe(120_000);
    // Ordinary TI = 120,000−16,100−20,000(pref) = 83,900.
    expect(result.taxableIncome).toBe(103_900);
  });
});

describe('computeYear — CTC', () => {
  it('full credit under the threshold', () => {
    const { result } = run(
      baseProfile({ filingStatus: 'mfj', wages: 150_000, dependentsUnder17: 2 }),
    );
    expect(result.ctc).toBe(4_400);
  });

  it('phases out $50 per $1,000 over the threshold', () => {
    const { result } = run(
      baseProfile({ filingStatus: 'mfj', wages: 420_000, dependentsUnder17: 2 }),
    );
    // 20,000 over → 20 steps × $50 = 1,000 → 4,400 − 1,000 = 3,400.
    expect(result.ctc).toBe(3_400);
  });

  it('other-dependent credit is $500 each', () => {
    const { result } = run(
      baseProfile({ filingStatus: 'mfj', wages: 150_000, otherDependents: 3 }),
    );
    expect(result.ctc).toBe(1_500);
  });

  it('credit never exceeds tax before credits', () => {
    const { result } = run(
      baseProfile({ filingStatus: 'mfj', wages: 30_000, dependentsUnder17: 3 }),
    );
    expect(result.ctc).toBe(result.incomeTaxBeforeCredits);
    expect(result.incomeTax).toBe(0);
  });
});

describe('computeYear — SALT + itemized', () => {
  it('cap applies below the phase-down threshold', () => {
    const { result } = run(
      baseProfile({
        filingStatus: 'mfj',
        wages: 300_000,
        itemized: {
          stateLocalTaxesPaid: 50_000,
          mortgageInterest: 20_000,
          charitable: 0,
          other: 0,
        },
      }),
    );
    expect(result.saltDeducted).toBe(40_400);
    expect(result.usedItemized).toBe(true);
    expect(result.itemizedTotal).toBe(60_400);
  });

  it('phase-down shrinks the cap 30¢ per MAGI dollar over the threshold', () => {
    const { result } = run(
      baseProfile({
        filingStatus: 'mfj',
        wages: 600_000,
        itemized: {
          stateLocalTaxesPaid: 50_000,
          mortgageInterest: 30_000,
          charitable: 0,
          other: 0,
        },
      }),
    );
    // cap = max(10,000, 40,400 − 0.30×95,000 = 11,900) → 11,900.
    expect(result.saltDeducted).toBe(11_900);
    expect(result.itemizedTotal).toBe(41_900);
  });

  it('floors at $10,000 for very high MAGI', () => {
    const { result } = run(
      baseProfile({
        filingStatus: 'mfj',
        wages: 900_000,
        itemized: {
          stateLocalTaxesPaid: 60_000,
          mortgageInterest: 40_000,
          charitable: 0,
          other: 0,
        },
      }),
    );
    expect(result.saltDeducted).toBe(10_000);
  });

  it('falls back to the standard deduction when itemized is lower', () => {
    const { result } = run(
      baseProfile({
        filingStatus: 'mfj',
        wages: 600_000,
        itemized: {
          stateLocalTaxesPaid: 50_000,
          mortgageInterest: 20_000,
          charitable: 0,
          other: 0,
        },
      }),
    );
    // 11,900 + 20,000 = 31,900 < 32,200 standard.
    expect(result.usedItemized).toBe(false);
    expect(result.standardDeduction).toBe(32_200);
  });
});

describe('computeYear — §469 passive', () => {
  const rental = (netIncome: number, active = true) => ({
    id: 'r1',
    name: 'Rental',
    netIncome,
    activeParticipant: active,
  });

  it('full $25k allowance under 100k MAGI', () => {
    const { result } = run(baseProfile({ wages: 80_000, rentals: [rental(-30_000)] }));
    expect(result.passiveAllowedLoss).toBe(25_000);
    expect(result.passiveSuspended).toBe(5_000);
    expect(result.agi).toBe(55_000);
  });

  it('allowance phases out 50¢ per MAGI dollar over 100k', () => {
    const { result } = run(baseProfile({ wages: 120_000, rentals: [rental(-30_000)] }));
    // allowance = 25,000 − 10,000 = 15,000.
    expect(result.passiveAllowedLoss).toBe(15_000);
    expect(result.passiveSuspended).toBe(15_000);
  });

  it('no allowance at/above 150k MAGI — loss fully suspended', () => {
    const { result, carryOut } = run(baseProfile({ wages: 200_000, rentals: [rental(-30_000)] }));
    expect(result.passiveAllowedLoss).toBe(0);
    expect(result.passiveSuspended).toBe(30_000);
    expect(carryOut.passiveByActivity['r1']).toBe(30_000);
    expect(result.agi).toBe(200_000);
  });

  it('non-active-participation losses get no allowance', () => {
    const { result } = run(baseProfile({ wages: 80_000, rentals: [rental(-30_000, false)] }));
    expect(result.passiveAllowedLoss).toBe(0);
    expect(result.passiveSuspended).toBe(30_000);
  });

  it('suspended losses release against the same activity income next year', () => {
    const y1 = run(baseProfile({ wages: 200_000, rentals: [rental(-30_000)] }));
    const y2 = run(baseProfile({ wages: 200_000, rentals: [rental(10_000)] }), y1.carryOut);
    // 10,000 income absorbed by 30,000 suspension → 0 included, 20,000 remains.
    expect(y2.result.agi).toBe(200_000);
    expect(y2.result.passiveSuspended).toBe(20_000);
  });

  it('passive income offsets passive losses across activities', () => {
    const { result } = run(
      baseProfile({
        wages: 200_000,
        rentals: [
          { id: 'a', name: 'A', netIncome: 20_000, activeParticipant: true },
          { id: 'b', name: 'B', netIncome: -15_000, activeParticipant: true },
        ],
      }),
    );
    expect(result.agi).toBe(205_000);
    expect(result.passiveSuspended).toBe(0);
  });
});

describe('computeYear — hooks and totals', () => {
  it('adjustments hook reduces AGI', () => {
    const { result } = run(baseProfile({ wages: 100_000, adjustments: 5_000 }));
    expect(result.agi).toBe(95_000);
  });

  it('otherCredits reduce tax but never below zero', () => {
    const { result } = run(baseProfile({ wages: 40_000, otherCredits: 100_000 }));
    expect(result.incomeTax).toBe(0);
  });

  it('corpTaxPaid and otherTaxes land in totalBurden', () => {
    const a = run(baseProfile({ filingStatus: 'mfj', wages: 200_000 })).result;
    const b = run(
      baseProfile({ filingStatus: 'mfj', wages: 200_000, corpTaxPaid: 7_000, otherTaxes: 500 }),
    ).result;
    expect(b.totalBurden - a.totalBurden).toBe(7_500);
  });

  it('HSA and retirement contributions are above the line', () => {
    const { result } = run(
      baseProfile({ wages: 100_000, hsaContribution: 4_400, retirementContributions: 24_500 }),
    );
    expect(result.agi).toBe(100_000 - 4_400 - 24_500);
  });

  it('qbiReduction hook shrinks the QBI deduction', () => {
    const biz = {
      id: 'b1',
      name: 'Biz',
      kind: 'schedule-c' as const,
      netProfit: 100_000,
      employeeWages: 0,
      ownerWages: 0,
      sstb: false,
      qbiEligible: true,
    };
    const withHook = run(baseProfile({ businesses: [biz], qbiReduction: 20_000 })).result;
    const without = run(baseProfile({ businesses: [biz] })).result;
    expect(withHook.qbiDeduction).toBeLessThan(without.qbiDeduction);
  });
});
