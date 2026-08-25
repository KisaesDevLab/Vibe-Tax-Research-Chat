import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'k1',
  maxPages: 4,
  systemGuide: `Schedule K-1 (from 1120-S, 1065, or 1041 — Part I identifies the issuer). Pull:
- ownership[]: ONE entry for this recipient. pct from Part II (1120-S: item J "Shareholder's percentage of stock ownership"; 1065: item J profit/loss/capital percentages — use profit % end-of-year). role 'shareholder' (1120-S source) or 'partner'/'member' (1065). owner as initials or role label only — Part II names are PII, never emit them.
- entity.type of the ISSUER from Part I (s_corp for 1120-S K-1, partnership for 1065) — path entity.type only when the client IS the issuer entity; when the client is the recipient, skip entity.* and emit income facts instead.
- income.characters: 'k1_active' when Part III shows self-employment earnings or material-participation boxes; 'k1_passive' otherwise; add 'rental' when box 2 rental income is present.
- income.sources[]: one entry labeled with the issuer's form type (e.g. "S corp K-1"), approxBand from box 1.
- carryforwards[]: basis/at-risk/passive carryover statements attached to the K-1.
Disambiguation: K-1 layouts are two-column — read Part/box numbers, not visual position. A 1041 K-1 (estate/trust) → income.characters 'other' with a note in display.`,
};
