import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'f1065',
  maxPages: 10,
  systemGuide: `Form 1065 (partnership return). Pull:
- entity.type 'partnership' (or 'smllc' only when the return itself says single-member — rare on a 1065); formationState, fiscalYearEnd, accountingMethod from the header and Schedule B.
- ownership[]: one entry per partner summarized on Schedule B-1 or the K-1 roster; owner as initials or role label, pct from profit/capital percentages (prefer profit %), role 'partner'; relatedParty true when Schedule B-1 shows family attribution.
- income.characters: 'k1_active'/'k1_passive' per general vs limited partner presumption; rental partnerships add 'rental'.
- stateFootprint[]: address-block state (nexusBasis 'physical'); state apportionment or composite-return attachments add entries.
- property[]: Form 4562 / depreciation schedule rows (kind, placedInService, basis, method).
- carryforwards[]: section 704(d)/at-risk/passive statements → 'passive_loss' where shown.
- electionsInEffect[]: e.g. section 754 election statement → code '754'.`,
};
