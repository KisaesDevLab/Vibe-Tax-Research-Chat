// Phase 18 + 19 — sidecar JSON extraction tests.
import { describe, expect, it } from 'vitest';
import { extractAuthorities, decorateVerification } from './authorities.js';
import { extractCompliance } from './compliance.js';

const SAMPLE = `
The QBI deduction under IRC § 199A …

\`\`\`json authorities
[
  {
    "cite": "26 U.S.C. § 199A(c)(1)",
    "type": "statute",
    "weight": "primary",
    "source": "https://uscode.house.gov/view.xhtml?req=199A",
    "verified_this_turn": false
  }
]
\`\`\`

\`\`\`json compliance
{
  "ssts_1_1": { "ok": true },
  "ssts_2_3": { "ok": false, "note": "estimate flag" },
  "loper_bright_caveat": true
}
\`\`\`
`;

describe('extractAuthorities', () => {
  it('parses the sidecar JSON', () => {
    const a = extractAuthorities(SAMPLE);
    expect(a).toHaveLength(1);
    expect(a[0]?.cite).toBe('26 U.S.C. § 199A(c)(1)');
  });

  it('returns empty when no sidecar present', () => {
    expect(extractAuthorities('plain text')).toEqual([]);
  });

  it('returns empty on malformed JSON', () => {
    expect(extractAuthorities('```json authorities\n[bogus\n```')).toEqual([]);
  });

  it('decorateVerification flips verified=true when source URL was fetched', () => {
    const a = extractAuthorities(SAMPLE);
    const decorated = decorateVerification(a, [
      { url: 'https://uscode.house.gov/view.xhtml?req=199A', domain: 'uscode.house.gov' },
    ]);
    expect(decorated[0]?.verified_this_turn).toBe(true);
  });

  it('decorateVerification keeps verified=false when source not fetched', () => {
    const a = extractAuthorities(SAMPLE);
    const decorated = decorateVerification(a, []);
    expect(decorated[0]?.verified_this_turn).toBe(false);
  });
});

describe('extractCompliance', () => {
  it('parses the sidecar JSON', () => {
    const c = extractCompliance(SAMPLE);
    expect(c?.ssts_1_1?.ok).toBe(true);
    expect(c?.ssts_2_3?.ok).toBe(false);
    expect(c?.loper_bright_caveat).toBe(true);
  });

  it('returns undefined when no sidecar', () => {
    expect(extractCompliance('plain')).toBeUndefined();
  });
});
