import { describe, it, expect } from 'vitest';
import { evaluateSuggestRule, evaluateNode, resolveField } from './suggest.js';

const profile = {
  filingStatus: 'mfj',
  wages: 120_000,
  hsaContribution: 0,
  businesses: [
    { kind: 'schedule-c', netProfit: 80_000, employeeWages: 0 },
    { kind: 's-corp', netProfit: 200_000, employeeWages: 50_000 },
  ],
  rentals: [{ id: 'r1', netIncome: -10_000 }],
  state: { code: 'MO', flatRate: 0.047 },
};

describe('resolveField', () => {
  it('resolves dot paths', () => {
    expect(resolveField(profile, 'state.code')).toBe('MO');
    expect(resolveField(profile, 'wages')).toBe(120_000);
  });
  it('derives virtual aggregates', () => {
    expect(resolveField(profile, 'totalBusinessProfit')).toBe(280_000);
    expect(resolveField(profile, 'hasScheduleC')).toBe(true);
    expect(resolveField(profile, 'hasSCorp')).toBe(true);
    expect(resolveField(profile, 'hasRental')).toBe(true);
    expect(resolveField(profile, 'hasEmployees')).toBe(true);
  });
  it('missing paths are undefined', () => {
    expect(resolveField(profile, 'nope.nested')).toBeUndefined();
  });
});

describe('evaluateNode ops', () => {
  it.each([
    [{ field: 'wages', op: 'eq', value: 120_000 }, true],
    [{ field: 'wages', op: 'ne', value: 0 }, true],
    [{ field: 'wages', op: 'gt', value: 100_000 }, true],
    [{ field: 'wages', op: 'gte', value: 120_000 }, true],
    [{ field: 'wages', op: 'lt', value: 100_000 }, false],
    [{ field: 'wages', op: 'lte', value: 120_000 }, true],
    [{ field: 'filingStatus', op: 'in', value: ['mfj', 'single'] }, true],
    [{ field: 'state', op: 'exists' }, true],
    [{ field: 'missing', op: 'exists' }, false],
  ] as const)('%j → %s', (leaf, expected) => {
    expect(evaluateNode(profile, leaf as never)).toBe(expected);
  });

  it('nests all/any/not', () => {
    expect(
      evaluateNode(profile, {
        all: [
          { field: 'hasSCorp', op: 'eq', value: true },
          {
            any: [
              { field: 'wages', op: 'gt', value: 500_000 },
              { not: { field: 'hsaContribution', op: 'gt', value: 0 } },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe('evaluateSuggestRule', () => {
  it('matches and renders the reason template', () => {
    const r = evaluateSuggestRule(profile, {
      all: [{ field: 'totalBusinessProfit', op: 'gte', value: 100_000 }],
      reason: 'Business profit of ${totalBusinessProfit} supports this strategy.',
    });
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('Business profit of $280,000 supports this strategy.');
  });

  it('non-match returns empty reason', () => {
    const r = evaluateSuggestRule(profile, {
      all: [{ field: 'wages', op: 'gt', value: 1_000_000 }],
      reason: 'never',
    });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('');
  });

  it('an empty rule never matches', () => {
    expect(evaluateSuggestRule(profile, { reason: 'x' } as never).matched).toBe(false);
  });
});
