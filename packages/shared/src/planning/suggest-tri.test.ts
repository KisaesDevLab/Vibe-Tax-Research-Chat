// TP-5a — tri-state facts evaluation. The legacy suite (suggest.test.ts)
// is untouched on purpose: it proves the two-valued surface didn't move.
import { describe, expect, it } from 'vitest';
import {
  describeLeaf,
  evaluateLeafTri,
  evaluateNodeTri,
  evaluateSuggestRuleTri,
  kleeneNot,
  resolveFactPath,
  type SuggestContext,
  type SuggestLeaf,
} from './suggest.js';

const FACTS = {
  entity: { type: 's_corp', sources: null },
  ownership: [
    { owner: 'A.B.', pct: 60, role: 'shareholder', relatedParty: true },
    { owner: 'C.D.', pct: 40, role: 'shareholder' }, // relatedParty missing
  ],
  stateFootprint: [{ state: 'MO', nexusBasis: 'domicile', ptetElected: null }],
  electionsInEffect: [{ code: 's_election', since: '2020' }],
  carryforwards: [],
  property: [{ kind: 'commercial', basis: 850000 }],
  household: { filingStatus: 'mfj', dependents: [{ ageBand: '6_12', relationship: 'child' }] },
  lifeEvents: [],
  openQuestions: [],
  income: { characters: ['k1_active'], sources: [] },
  narrative: '',
};

const ctx: SuggestContext = { profile: { wages: 50_000, businesses: [] }, facts: FACTS };
const noFacts: SuggestContext = { profile: { wages: 50_000 } };

function leaf(field: string, op: SuggestLeaf['op'], value?: unknown): SuggestLeaf {
  return { field, op, value };
}

describe('resolveFactPath', () => {
  it('scalar path resolves the value', () => {
    expect(resolveFactPath(FACTS, 'entity.type')).toEqual({ kind: 'value', value: 's_corp' });
  });
  it('missing scalar and explicit null are missing', () => {
    expect(resolveFactPath(FACTS, 'entity.formationState')).toEqual({ kind: 'missing' });
    expect(resolveFactPath(FACTS, 'stateFootprint[].ptetElected')).toMatchObject({
      kind: 'set',
      values: [],
      anyMissing: true,
    });
  });
  it('selector fans out and tracks missing sub-paths', () => {
    expect(resolveFactPath(FACTS, 'ownership[].relatedParty')).toEqual({
      kind: 'set',
      values: [true],
      anyMissing: true,
    });
  });
  it('empty array present is a known-empty set, absent array is missing', () => {
    expect(resolveFactPath(FACTS, 'carryforwards[]')).toEqual({
      kind: 'set',
      values: [],
      anyMissing: false,
    });
    // Absent array short-circuits to missing — same 'unknown' downstream.
    expect(
      resolveFactPath({ ...FACTS, carryforwards: undefined } as never, 'carryforwards[]'),
    ).toEqual({ kind: 'missing' });
  });
});

describe('evaluateLeafTri', () => {
  it.each([
    [leaf('facts.entity.type', 'eq', 's_corp'), true],
    [leaf('facts.entity.type', 'eq', 'c_corp'), false],
    [leaf('facts.entity.type', 'ne', 'c_corp'), true],
    [leaf('facts.entity.formationState', 'eq', 'MO'), 'unknown'],
    [leaf('facts.entity.formationState', 'exists'), 'unknown'],
    [leaf('facts.entity.formationState', 'ne', 'MO'), 'unknown'],
    [leaf('facts.stateFootprint[].ptetElected', 'eq', true), 'unknown'], // explicit null
    [leaf('facts.ownership[].relatedParty', 'eq', true), true], // some element
    [leaf('facts.ownership[].pct', 'gt', 90), 'unknown'], // none satisfy but nothing... pct present on all — false
  ] as Array<[SuggestLeaf, boolean | 'unknown']>)('%j → %s', (l, expected) => {
    if (l.field === 'facts.ownership[].pct') {
      // pct exists on every element: none > 90 and nothing missing → false.
      expect(evaluateLeafTri(ctx, l)).toBe(false);
    } else {
      expect(evaluateLeafTri(ctx, l)).toBe(expected);
    }
  });

  it('present-but-empty array: exists is false, not unknown', () => {
    expect(evaluateLeafTri(ctx, leaf('facts.carryforwards[]', 'exists'))).toBe(false);
  });
  it('populated array: exists is true; absent array: unknown', () => {
    expect(evaluateLeafTri(ctx, leaf('facts.household.dependents[]', 'exists'))).toBe(true);
    const trimmed = { ...ctx, facts: { ...FACTS, household: {} } };
    expect(evaluateLeafTri(trimmed, leaf('facts.household.dependents[]', 'exists'))).toBe(
      'unknown',
    );
  });
  it('no fact snapshot in context → every facts leaf unknown', () => {
    expect(evaluateLeafTri(noFacts, leaf('facts.entity.type', 'eq', 's_corp'))).toBe('unknown');
  });
  it('profile leaves are never unknown', () => {
    expect(evaluateLeafTri(ctx, leaf('wages', 'gt', 10_000))).toBe(true);
    expect(evaluateLeafTri(ctx, leaf('nonexistent.path', 'exists'))).toBe(false);
    expect(evaluateLeafTri(noFacts, leaf('hasBusiness', 'eq', true))).toBe(false);
  });
});

describe('Kleene composition', () => {
  const U = leaf('facts.entity.formationState', 'exists'); // unknown
  const T = leaf('facts.entity.type', 'eq', 's_corp'); // true
  const F = leaf('facts.entity.type', 'eq', 'c_corp'); // false

  it('all: false dominates, then unknown', () => {
    expect(evaluateNodeTri(ctx, { all: [T, F, U] })).toBe(false);
    expect(evaluateNodeTri(ctx, { all: [T, U] })).toBe('unknown');
    expect(evaluateNodeTri(ctx, { all: [T, T] })).toBe(true);
  });
  it('any: true dominates, then unknown', () => {
    expect(evaluateNodeTri(ctx, { any: [F, U, T] })).toBe(true);
    expect(evaluateNodeTri(ctx, { any: [F, U] })).toBe('unknown');
    expect(evaluateNodeTri(ctx, { any: [F, F] })).toBe(false);
  });
  it('not(unknown) is unknown', () => {
    expect(kleeneNot('unknown')).toBe('unknown');
    expect(evaluateNodeTri(ctx, { not: U })).toBe('unknown');
    expect(evaluateNodeTri(ctx, { not: T })).toBe(false);
  });
});

describe('evaluateSuggestRuleTri', () => {
  it('classifies leaves with polarity and reports status', () => {
    const result = evaluateSuggestRuleTri(ctx, {
      all: [
        leaf('facts.entity.type', 'eq', 's_corp'),
        { not: leaf('facts.stateFootprint[].ptetElected', 'eq', true) },
        leaf('facts.household.dependents[].ageBand', 'in', ['6_12', '13_17']),
      ],
      reason: 'S corp ({facts.entity.type}) with young dependents',
    });
    expect(result.status).toBe('toConfirm'); // the not(unknown) leg
    expect(result.matched).toContain('facts.entity.type is s_corp');
    expect(result.matched).toContain('facts.household.dependents[].ageBand is one of 6_12, 13_17');
    expect(result.toConfirm).toHaveLength(1);
    expect(result.reason).toBe('S corp (s_corp) with young dependents');
  });

  it('uses author labels and renders unknown reasons with ?', () => {
    const result = evaluateSuggestRuleTri(noFacts, {
      all: [{ ...leaf('facts.entity.type', 'eq', 's_corp'), label: 'S corporation on file' }],
      reason: 'Entity is {facts.entity.type}',
    });
    expect(result.status).toBe('toConfirm');
    expect(result.toConfirm).toEqual(['S corporation on file']);
    expect(result.reason).toBe('Entity is ?');
  });

  it('excluded rules render no reason; empty rule is excluded', () => {
    const excluded = evaluateSuggestRuleTri(ctx, {
      all: [leaf('facts.entity.type', 'eq', 'c_corp')],
      reason: 'nope',
    });
    expect(excluded.status).toBe('excluded');
    expect(excluded.reason).toBe('');
    expect(evaluateSuggestRuleTri(ctx, { reason: 'x' }).status).toBe('excluded');
  });

  it('describeLeaf mechanical fallback marks negation', () => {
    expect(describeLeaf(leaf('facts.entity.type', 'eq', 's_corp'), true)).toBe(
      'not: facts.entity.type is s_corp',
    );
  });
});
