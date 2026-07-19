import { describe, it, expect } from 'vitest';
import { canTransition, evaluateReviewGate } from './workflow.js';

describe('canTransition', () => {
  it.each([
    ['draft', 'in-review', true],
    ['in-review', 'draft', true],
    ['in-review', 'presented', true],
    ['presented', 'engaged', true],
    ['engaged', 'delivered', true],
    ['delivered', 'archived', true],
    ['draft', 'presented', false],
    ['presented', 'draft', false],
    ['presented', 'in-review', false],
    ['archived', 'draft', false],
    ['engaged', 'presented', false],
  ] as const)('%s → %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});

describe('evaluateReviewGate', () => {
  const records = new Map([
    ['augusta-rule', { riskRating: 'moderate', reviewChecklist: ['comps', 'minutes'] }],
    ['reasonable-comp-study', { riskRating: 'elevated', reviewChecklist: ['study on file'] }],
  ]);

  const base = {
    selections: [{ strategyId: 'augusta-rule', version: '1.0.0', params: {} }],
    records,
    reviewState: { 'augusta-rule:0': true, 'augusta-rule:1': true },
    linkedStrategies: new Set<string>(),
    reviewerId: 'reviewer-1',
    preparerId: 'preparer-1',
  };

  it('passes when checklist complete and no elevated strategies', () => {
    expect(evaluateReviewGate(base).ok).toBe(true);
  });

  it('fails without a reviewer', () => {
    const r = evaluateReviewGate({ ...base, reviewerId: null });
    expect(r.failures.some((f) => f.code === 'no_reviewer')).toBe(true);
  });

  it('fails when reviewer is the preparer', () => {
    const r = evaluateReviewGate({ ...base, reviewerId: 'preparer-1' });
    expect(r.failures.some((f) => f.code === 'reviewer_is_preparer')).toBe(true);
  });

  it('fails on unchecked checklist items', () => {
    const r = evaluateReviewGate({ ...base, reviewState: { 'augusta-rule:0': true } });
    expect(r.failures.some((f) => f.code === 'checklist_incomplete')).toBe(true);
  });

  it('elevated-risk without a linked archive is a hard failure', () => {
    const r = evaluateReviewGate({
      ...base,
      selections: [
        ...base.selections,
        { strategyId: 'reasonable-comp-study', version: '1.0.0', params: {} },
      ],
      reviewState: { ...base.reviewState, 'reasonable-comp-study:0': true },
    });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.code === 'elevated_risk_unlinked')).toBe(true);
  });

  it('elevated-risk WITH a linked archive passes', () => {
    const r = evaluateReviewGate({
      ...base,
      selections: [
        ...base.selections,
        { strategyId: 'reasonable-comp-study', version: '1.0.0', params: {} },
      ],
      reviewState: { ...base.reviewState, 'reasonable-comp-study:0': true },
      linkedStrategies: new Set(['reasonable-comp-study']),
    });
    expect(r.ok).toBe(true);
  });
});
