import { describe, expect, it } from 'vitest';
import { emptyFactPattern } from '@vibe/shared';
import { factCandidateEmitSchema, validateFactPattern } from './fact-pattern.js';

function fullPattern() {
  const f = emptyFactPattern();
  f.entity = { type: 's_corp', formationState: 'MO', sCorpEffectiveDate: '2020-01-01' };
  f.ownership = [
    {
      owner: 'A.B.',
      pct: 60,
      role: 'shareholder',
      relatedParty: true,
      sources: [
        { documentId: '7d0796f6-27a5-4c1e-9c58-6f3ac54a9f66', page: 3, method: 'extracted' },
      ],
    },
  ];
  f.stateFootprint = [{ state: 'MO', nexusBasis: 'domicile', ptetElected: false }];
  f.income = {
    characters: ['w2', 'k1_active'],
    sources: [{ label: 'S corp K-1', character: 'k1_active', approxBand: '100k_500k' }],
  };
  f.electionsInEffect = [{ code: 's_election', since: '2020' }];
  f.carryforwards = [{ type: 'nol', amount: 45000, expires: '2039' }];
  f.property = [
    { kind: 'commercial', placedInService: '2021-06-01', basis: 850000, method: 'macrs' },
  ];
  f.household = {
    filingStatus: 'mfj',
    dependents: [{ ageBand: '6_12', relationship: 'child' }],
  };
  f.lifeEvents = [{ year: 2024, event: 'business_start' }];
  f.openQuestions = [{ question: 'PTET for 2026?', raisedBy: 'staff', status: 'open' }];
  f.narrative = 'Owner-operator S corp; spouse W-2.';
  return f;
}

describe('validateFactPattern', () => {
  it('accepts a full pattern and the empty pattern', () => {
    expect(validateFactPattern(fullPattern()).ok).toBe(true);
    expect(validateFactPattern(emptyFactPattern()).ok).toBe(true);
  });

  it('rejects a missing section', () => {
    const bad = fullPattern() as unknown as Record<string, unknown>;
    delete bad.household;
    const res = validateFactPattern(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.gate).toBe('schema');
  });

  it('rejects a bad source method and a bad ageBand', () => {
    const badMethod = fullPattern();
    badMethod.ownership[0]!.sources = [
      // @ts-expect-error deliberate bad method
      { documentId: '7d0796f6-27a5-4c1e-9c58-6f3ac54a9f66', page: 1, method: 'guessed' },
    ];
    expect(validateFactPattern(badMethod).ok).toBe(false);

    const badBand = fullPattern();
    // @ts-expect-error deliberate bad band
    badBand.household.dependents = [{ ageBand: '0-5', relationship: 'child' }];
    expect(validateFactPattern(badBand).ok).toBe(false);
  });

  it('rejects unknown keys (strict objects)', () => {
    const sneaky = fullPattern() as unknown as Record<string, unknown>;
    (sneaky.household as Record<string, unknown>).ssn = '123-45-6789';
    expect(validateFactPattern(sneaky).ok).toBe(false);
  });
});

describe('factCandidateEmitSchema', () => {
  it('accepts a minimal emitted candidate and rejects extras', () => {
    const good = {
      path: 'household.filingStatus',
      section: 'household',
      value: 'mfj',
      display: 'Filing status: MFJ',
      page: 1,
    };
    expect(factCandidateEmitSchema.safeParse(good).success).toBe(true);
    expect(factCandidateEmitSchema.safeParse({ ...good, ssn: 'x' }).success).toBe(false);
    expect(factCandidateEmitSchema.safeParse({ ...good, section: 'nope' }).success).toBe(false);
  });
});
