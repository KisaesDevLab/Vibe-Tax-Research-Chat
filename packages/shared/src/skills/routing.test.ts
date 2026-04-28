// Phase 11 — routing tests.
import { describe, expect, it } from 'vitest';
import { selectSkills } from './routing.js';

const SAMPLE_AVAILABLE = [
  { local_slug: 'cpa-pack-index' },
  { local_slug: 'compliance-ssts-circular230' },
  { local_slug: 'irc-199a-qbi' },
  { local_slug: 'irc-174-rd' },
  { local_slug: 'irc-163j-interest' },
  { local_slug: 'irc-280e-cannabis' },
  { local_slug: 'irc-1031-like-kind' },
  { local_slug: 'form-1040-individual' },
  { local_slug: 'form-1120s-scorp' },
  { local_slug: 'form-1065-partnership' },
  { local_slug: 'state-ca' },
  { local_slug: 'state-ny' },
  { local_slug: 'state-tx' },
  { local_slug: 'irs-notice-decoder' },
  { local_slug: 'penalty-abatement' },
  { local_slug: 'tax-court-research' },
  { local_slug: 'admin-deference-doctrine' },
];

describe('selectSkills', () => {
  it('always attaches dispatcher and compliance', () => {
    const r = selectSkills({ message: 'hi', available: SAMPLE_AVAILABLE });
    expect(r.slugs).toContain('cpa-pack-index');
    expect(r.slugs).toContain('compliance-ssts-circular230');
  });

  it('routes IRC § 199A questions to the QBI skill', () => {
    const r = selectSkills({
      message: 'How does IRC § 199A QBI deduction apply to a SSTB above the threshold?',
      available: SAMPLE_AVAILABLE,
    });
    expect(r.slugs).toContain('irc-199a-qbi');
  });

  it('routes a California question to state-ca', () => {
    const r = selectSkills({
      message: 'My client moved to California mid-year. What about 540NR?',
      available: SAMPLE_AVAILABLE,
    });
    expect(r.slugs).toContain('state-ca');
  });

  it('caps at 8 skills', () => {
    const r = selectSkills({
      message:
        'IRC § 199A and § 174 and § 163(j) and § 280E and § 1031, with form 1040, 1120-S, 1065, in California and New York and Texas',
      available: SAMPLE_AVAILABLE,
    });
    expect(r.slugs.length).toBeLessThanOrEqual(8);
    expect(r.truncated).toBe(true);
  });

  it('routes IRS notice numbers to the decoder', () => {
    const r = selectSkills({
      message: 'Got a CP-2000 from the IRS, what now?',
      available: SAMPLE_AVAILABLE,
    });
    expect(r.slugs).toContain('irs-notice-decoder');
  });

  it('honors custom skill routing keywords', () => {
    const r = selectSkills({
      message: 'Need help with the cannabis 280E carve-out for vertically integrated operators',
      available: SAMPLE_AVAILABLE,
      custom: [{ local_slug: 'firm-cannabis-memo', routing_keywords: ['cannabis', '280E'] }],
    });
    expect(r.slugs).toContain('firm-cannabis-memo');
  });
});
