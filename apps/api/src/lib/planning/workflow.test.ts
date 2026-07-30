import { describe, it, expect } from 'vitest';
import { allowedTransitions, canTransition, evaluateReviewGate, isReopen } from './workflow.js';

describe('canTransition', () => {
  it.each([
    ['draft', 'in-review', true],
    ['in-review', 'draft', true],
    ['in-review', 'presented', true],
    ['presented', 'engaged', true],
    ['engaged', 'delivered', true],
    ['delivered', 'archived', true],
    ['draft', 'presented', false],
    ['presented', 'draft', true],
    ['presented', 'in-review', false],
    ['archived', 'draft', false],
    ['engaged', 'presented', false],
  ] as const)('%s → %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});

describe('reopening a presented plan', () => {
  it('allows presented → draft so a frozen plan can be corrected', () => {
    expect(canTransition('presented', 'draft')).toBe(true);
    expect(canTransition('presented', 'draft', false)).toBe(true);
    expect(isReopen('presented', 'draft')).toBe(true);
  });

  it('keeps the forward path from presented intact', () => {
    expect(allowedTransitions('presented', true)).toEqual(['engaged', 'archived', 'draft']);
  });

  it('does not open a back-edge from engaged, delivered, or archived', () => {
    expect(canTransition('engaged', 'draft')).toBe(false);
    expect(canTransition('delivered', 'draft')).toBe(false);
    expect(canTransition('archived', 'draft')).toBe(false);
    expect(isReopen('engaged', 'draft')).toBe(false);
  });
});

describe('optional partner review', () => {
  it('lets draft reach presented directly when review is not required', () => {
    expect(canTransition('draft', 'presented', false)).toBe(true);
    expect(allowedTransitions('draft', false)).toEqual(['in-review', 'presented']);
  });

  it('keeps the in-review path available when review is not required', () => {
    expect(canTransition('draft', 'in-review', false)).toBe(true);
    expect(canTransition('in-review', 'presented', false)).toBe(true);
  });

  it('still blocks draft → presented when review IS required', () => {
    expect(canTransition('draft', 'presented', true)).toBe(false);
    expect(allowedTransitions('draft', true)).toEqual(['in-review']);
  });

  it('defaults to the strict graph when the flag is omitted', () => {
    expect(canTransition('draft', 'presented')).toBe(false);
  });

  it('does not loosen any transition other than draft → presented', () => {
    for (const from of ['in-review', 'presented', 'engaged', 'delivered', 'archived'] as const) {
      expect(allowedTransitions(from, false)).toEqual(allowedTransitions(from, true));
    }
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
