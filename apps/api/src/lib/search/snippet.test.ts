import { describe, expect, it } from 'vitest';
import { buildSnippet, likePattern } from './snippet.js';

describe('likePattern', () => {
  it('wraps in wildcards and escapes LIKE metacharacters', () => {
    expect(likePattern('199A')).toBe('%199A%');
    expect(likePattern('50% bonus_dep\\x')).toBe('%50\\% bonus\\_dep\\\\x%');
  });
});

describe('buildSnippet', () => {
  const body = `The QBI deduction under IRC § 199A is limited for specified service trades.

## Analysis

Taxable income above the threshold phases the deduction out **completely** for SSTBs.

\`\`\`json authorities
[{"cite": "26 U.S.C. § 199A", "type": "statute"}]
\`\`\``;

  it('centres on the first case-insensitive hit and marks cut edges', () => {
    const s = buildSnippet(body, 'THRESHOLD', 30);
    expect(s).toMatch(/^…/);
    expect(s).toMatch(/…$/);
    expect(s.toLowerCase()).toContain('threshold');
    expect(s).not.toContain('##');
  });

  it('never surfaces sidecar JSON', () => {
    const s = buildSnippet(body, 'statute');
    expect(s).not.toContain('"cite"');
    expect(s).not.toContain('authorities');
  });

  it('falls back to the opening prose when the hit is only in a sidecar', () => {
    const s = buildSnippet(body, 'statute', 20);
    expect(s.startsWith('The QBI deduction')).toBe(true);
  });

  it('does not open or close mid-word', () => {
    const s = buildSnippet(body, 'phases', 12);
    const inner = s.replace(/^…|…$/g, '');
    expect(body.replace(/\s+/g, ' ')).toContain(inner);
    expect(inner.startsWith(' ')).toBe(false);
  });
});
