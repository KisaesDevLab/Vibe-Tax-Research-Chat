// TP-12 — validator unit tests: one fixture per gate, exercised through
// the composed validateStrategyRecord entry point.
import { describe, it, expect } from 'vitest';
import { validateStrategyRecord, fleschKincaidGrade, lintCitation } from './index.js';

function baseRecord() {
  return {
    id: 'test-strategy',
    version: '1.0.0',
    status: 'draft',
    effectiveTaxYears: { from: 2026, to: null },
    lastReviewed: '2026-07-19',
    reviewedBy: null,
    changeLog: [{ version: '1.0.0', date: '2026-07-19', note: 'Initial authoring' }],
    name: 'Test Strategy',
    category: 'business-expenses',
    modeled: true,
    complexity: 2,
    riskRating: 'low',
    entityTypes: ['s-corp'],
    typicalSavingsBand: 'under-5k',
    advisor: {
      summary: 'A perfectly reasonable strategy summary for testing purposes.',
      mechanics: [
        'The deduction rests on IRC §162(a) as an ordinary and necessary expense.',
        'Documentation must be contemporaneous and complete.',
        'Payment must actually occur during the tax year.',
      ],
      authority: [
        { type: 'IRC', cite: 'IRC §162(a)', note: 'The deduction standard.' },
        { type: 'Reg', cite: 'Reg. §1.162-1', note: 'Implementing regulation.' },
      ],
      requirements: ['A trade or business.', 'Adequate records.'],
      risks: ['Disallowance on exam if records are thin.', 'Accuracy penalties.'],
      stateNotes: [
        'Conformity: most states conform to the federal deduction.',
        'PTET interaction: none beyond the ordinary deduction base.',
        'Missouri conforms through its federal starting point.',
      ],
      interactions: { requires: [], conflictsWith: [], synergiesWith: [] },
      reviewChecklist: ['Records exist.', 'Amounts reconcile.', 'Client understands the duty.'],
    },
    client: {
      teaser: 'A simple way to lower your tax bill.',
      headline: 'Deduct what you already spend',
      plainEnglish: [
        'Your business spends money on real things every year. Some of that spending can lower your tax bill when we set it up the right way.',
        'We handle the setup and the forms. You keep simple records and the savings show up on your return.',
      ],
      analogy: 'It is like using a coupon you already had in your pocket.',
      benefits: ['Lower tax bill', 'No change to how you run the business'],
      steps: ['WE set up the paperwork.', 'YOU keep the receipts.'],
      clientCommitments: ['Keep the receipts we ask for.'],
    },
    engagement: {
      implementationEffort: 'one-meeting',
      annualMaintenance: ['Annual record check.'],
      deliverables: ['Setup memo.'],
      feeGuidanceBand: null,
    },
    model: {
      applyOrder: 30,
      inputs: { type: 'object', properties: { amount: { type: 'number', minimum: 0 } } },
      apply: { module: 'test-strategy@1.0.0' },
      suggest: {
        all: [{ field: 'hasBusiness', op: 'eq', value: true }],
        reason: 'Any operating business can use this.',
      },
      goldenTests: [
        {
          name: 'case a',
          profile: {},
          params: { amount: 1000 },
          expect: { totalBurdenDelta: -300, tolerance: 1 },
        },
        {
          name: 'case b',
          profile: {},
          params: { amount: 2000 },
          expect: { totalBurdenDelta: -600, tolerance: 1 },
        },
      ],
    },
    monitoring: {
      watchAuthorities: ['IRC §162'],
      keywords: ['ordinary and necessary', 'business expense'],
      reviewTriggers: ['New case law.'],
    },
  };
}

describe('validateStrategyRecord', () => {
  it('accepts a complete modeled record', () => {
    const result = validateStrategyRecord(baseRecord());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('schema gate: rejects a modeled record without a model block', () => {
    const r = baseRecord() as Record<string, unknown>;
    delete r.model;
    const result = validateStrategyRecord(r);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.gate === 'schema' && e.path === 'model')).toBe(true);
  });

  it('schema gate: advisory records need a top-level suggest', () => {
    const r = baseRecord() as ReturnType<typeof baseRecord>;
    r.modeled = false;
    delete (r as Record<string, unknown>).model;
    const result = validateStrategyRecord(r);
    expect(result.errors.some((e) => e.path === 'suggest')).toBe(true);
    (r as Record<string, unknown>).suggest = {
      any: [{ field: 'hasBusiness', op: 'eq', value: true }],
      reason: 'Worth a look for any operating business.',
    };
    expect(validateStrategyRecord(r).ok).toBe(true);
  });

  it('schema gate: module id must match record id', () => {
    const r = baseRecord();
    r.model.apply.module = 'other-strategy@1.0.0';
    const result = validateStrategyRecord(r);
    expect(result.errors.some((e) => e.path === 'model.apply.module')).toBe(true);
  });

  it('schema gate: modeled strategies need at least two goldens', () => {
    const r = baseRecord();
    r.model.goldenTests = r.model.goldenTests.slice(0, 1);
    expect(validateStrategyRecord(r).ok).toBe(false);
  });

  it('citation gate: malformed cites are flagged', () => {
    const r = baseRecord();
    r.advisor.authority[0] = { type: 'Case', cite: 'some blog post I read', note: 'n/a' };
    const result = validateStrategyRecord(r);
    expect(
      result.errors.some((e) => e.gate === 'citation' && e.path === 'advisor.authority[0].cite'),
    ).toBe(true);
  });

  it('prose gate: banned words in client prose are flagged', () => {
    const r = baseRecord();
    r.client.teaser = 'A secret loophole the IRS does not want you to know.';
    const result = validateStrategyRecord(r);
    const hits = result.errors.filter((e) => e.gate === 'prose' && e.path === 'client.teaser');
    expect(hits.map((h) => h.message.match(/"(\w+)"/)?.[1]).sort()).toEqual(['loophole', 'secret']);
  });

  it('prose gate: dense client prose fails the reading level', () => {
    const r = baseRecord();
    r.client.plainEnglish = [
      'Notwithstanding the aforementioned considerations, the implementation of sophisticated organizational restructuring methodologies necessitates comprehensive evaluation of multifarious jurisdictional idiosyncrasies alongside interdependent regulatory promulgations, particularly considering contemporaneous documentation prerequisites characteristic of examination-resilient administrative infrastructures.',
      'Consequently, operationalizing these transformational determinations demands extraordinarily meticulous coordination.',
    ];
    const result = validateStrategyRecord(r);
    expect(result.errors.some((e) => e.gate === 'prose' && e.path === 'client.plainEnglish')).toBe(
      true,
    );
  });

  it('completeness gate: orphan section references in mechanics are flagged', () => {
    const r = baseRecord();
    r.advisor.mechanics.push('The exclusion also leans on §280A(g) for the owner side.');
    const result = validateStrategyRecord(r);
    expect(result.errors.some((e) => e.gate === 'completeness' && /280A/.test(e.message))).toBe(
      true,
    );
  });

  it('completeness gate: stateNotes topics are mandatory', () => {
    const r = baseRecord();
    r.advisor.stateNotes = ['Nothing much to say here.'];
    const result = validateStrategyRecord(r);
    const messages = result.errors.filter((e) => e.path === 'advisor.stateNotes');
    expect(messages).toHaveLength(3);
  });

  it('completeness gate: positive golden delta requires mayIncreaseBurden', () => {
    const r = baseRecord();
    r.model.goldenTests[0]!.expect.totalBurdenDelta = 500;
    expect(validateStrategyRecord(r).ok).toBe(false);
    (r.model as Record<string, unknown>).mayIncreaseBurden = true;
    expect(validateStrategyRecord(r).ok).toBe(true);
  });
});

describe('fleschKincaidGrade', () => {
  it('scores simple prose low and dense prose high', () => {
    const simple = fleschKincaidGrade('The cat sat on the mat. The dog ran to the park.');
    const dense = fleschKincaidGrade(
      'Institutional heterogeneity necessitates multidimensional reconceptualization of organizational epistemologies.',
    );
    expect(simple).toBeLessThan(4);
    expect(dense).toBeGreaterThan(15);
  });
});

describe('lintCitation', () => {
  it.each([
    ['IRC', 'IRC §280A(g)'],
    ['IRC', 'IRC §§1401-1402'],
    ['IRC', 'P.L. 119-21 (OBBBA) HSA provisions'],
    ['Reg', 'Reg. §1.162-7(b)(3)'],
    ['Case', 'Sinopoli v. Commissioner, T.C. Memo 2023-105'],
    ['Case', 'David E. Watson, P.C. v. United States, 668 F.3d 1008 (8th Cir. 2012)'],
    ['Admin', 'Rev. Proc. 2013-30'],
    ['Admin', 'Missouri SALT Parity Act, RSMo §143.436'],
    ['Admin', 'Form 5305-SEP'],
  ])('accepts %s "%s"', (type, cite) => {
    expect(lintCitation({ type, cite })).toBeNull();
  });

  it.each([
    ['IRC', 'section 162 somewhere'],
    ['Case', 'Sinopoli (2023)'],
    ['Reg', '1.162-7'],
  ])('rejects %s "%s"', (type, cite) => {
    expect(lintCitation({ type, cite })).not.toBeNull();
  });
});
