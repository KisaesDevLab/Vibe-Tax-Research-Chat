import { describe, it, expect } from 'vitest';
import {
  WEB_ALLOWLIST,
  WEB_ALLOWLIST_DOMAINS,
  WEB_ALLOWLIST_JURISDICTIONS,
  DEFAULT_WEB_BUDGET,
  describeReachableSources,
} from './web-allowlist.js';

const US_JURISDICTIONS = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

// Guards on the shape Anthropic's server tools accept for allowed_domains.
// A malformed entry is rejected at request time with a 400 that kills the whole
// call, and a redundant one silently eats budget in the domain filter list, so
// both are worth catching in CI rather than in a user's chat.
describe('WEB_ALLOWLIST', () => {
  it('has no duplicate domains', () => {
    const dupes = WEB_ALLOWLIST_DOMAINS.filter((d, i) => WEB_ALLOWLIST_DOMAINS.indexOf(d) !== i);
    expect(dupes).toEqual([]);
  });

  it('lists plain ASCII hostnames only — no scheme, port, path, or wildcard', () => {
    for (const domain of WEB_ALLOWLIST_DOMAINS) {
      // eslint-disable-next-line no-control-regex
      expect(domain, `${domain} must be ASCII (homograph risk)`).toMatch(/^[\x00-\x7F]+$/);
      expect(domain, `${domain} must not carry a scheme`).not.toMatch(/:\/\//);
      expect(domain, `${domain} must not carry a port`).not.toMatch(/:\d/);
      expect(
        domain,
        `${domain} must not carry a path — web_fetch matches domain only`,
      ).not.toContain('/');
      expect(domain, `${domain} must not use a wildcard`).not.toContain('*');
      expect(domain, `${domain} must be lower-case`).toBe(domain.toLowerCase());
      expect(domain.length, `${domain} must be 1-255 chars`).toBeGreaterThan(0);
      expect(domain.length, `${domain} must be 1-255 chars`).toBeLessThanOrEqual(255);
    }
  });

  it('rejects bare TLDs and single-label names', () => {
    for (const domain of WEB_ALLOWLIST_DOMAINS) {
      expect(
        domain.split('.').length,
        `${domain} must have at least two labels`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('contains no entry already covered by a broader entry', () => {
    // A listed domain covers its own subdomains, so listing both `mo.gov` and
    // `dor.mo.gov` wastes a slot. Keeps the list short against web_search's
    // `request_too_large` on long domain filter lists.
    const redundant = WEB_ALLOWLIST_DOMAINS.filter((d) =>
      WEB_ALLOWLIST_DOMAINS.some((other) => other !== d && d.endsWith(`.${other}`)),
    );
    expect(redundant).toEqual([]);
  });

  it('every entry carries a description', () => {
    for (const entry of WEB_ALLOWLIST) {
      expect(entry.description.trim(), `${entry.domain} needs a description`).not.toBe('');
    }
  });

  it('covers all 50 states plus DC, with no stray jurisdiction codes', () => {
    expect([...WEB_ALLOWLIST_JURISDICTIONS].sort()).toEqual([...US_JURISDICTIONS].sort());
  });

  it('tags every entry with a scope, and jurisdiction iff state-scoped', () => {
    for (const entry of WEB_ALLOWLIST) {
      expect(['federal', 'state']).toContain(entry.scope);
      if (entry.scope === 'state') {
        expect(entry.jurisdiction, `${entry.domain} needs a jurisdiction`).toMatch(/^[A-Z]{2}$/);
      } else {
        expect(entry.jurisdiction, `${entry.domain} is federal — no jurisdiction`).toBeUndefined();
      }
    }
  });
});

describe('describeReachableSources', () => {
  const text = describeReachableSources();

  it('names every federal domain, so the prompt cannot drift from the list', () => {
    for (const entry of WEB_ALLOWLIST.filter((e) => e.scope === 'federal')) {
      expect(text).toContain(entry.domain);
    }
  });

  it('states the true jurisdiction count', () => {
    expect(text).toContain(String(WEB_ALLOWLIST_JURISDICTIONS.length));
  });

  it('tells the model an out-of-list result is omitted, not an error', () => {
    // The whole point: an empty result must not read as a broken tool. This is
    // what stopped the model inventing "the search tool is rate-limited".
    expect(text).toMatch(/silently omitted/i);
    expect(text).toMatch(/NOT reported as an error/i);
  });

  it('names the unreachable categories explicitly', () => {
    for (const absent of ['CCH', 'Checkpoint', 'municipal', 'non-U.S.']) {
      expect(text).toContain(absent);
    }
  });
});

describe('DEFAULT_WEB_BUDGET', () => {
  it('allows enough searches for multi-jurisdiction research', () => {
    // Anthropic's guidance: comparative / multi-entity research "can use 10 or
    // more" searches. The old ceiling of 4 ran out mid-answer once the
    // allowlist spanned 51 jurisdictions.
    expect(DEFAULT_WEB_BUDGET.searches_per_turn).toBeGreaterThanOrEqual(10);
  });

  it('leaves enough fetches to verify what a search turns up', () => {
    expect(DEFAULT_WEB_BUDGET.fetches_per_turn).toBeGreaterThanOrEqual(
      DEFAULT_WEB_BUDGET.searches_per_turn,
    );
  });
});
