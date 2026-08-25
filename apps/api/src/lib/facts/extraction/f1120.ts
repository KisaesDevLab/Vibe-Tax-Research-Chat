import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'f1120',
  maxPages: 10,
  systemGuide: `Form 1120 (C corporation return). Pull:
- entity.type 'c_corp'; entity.formationState / fiscalYearEnd / accountingMethod from the header and Schedule K questions.
- ownership[]: Schedule G / Schedule K ownership questions — entries with initials or role labels only, role 'shareholder', pct where stated; relatedParty true for family or controlled-group attribution.
- income.characters evidenced by the return.
- stateFootprint[]: address-block state (nexusBasis 'physical'); apportionment attachments add states (nexusBasis 'economic').
- property[]: Form 4562 / depreciation schedule rows (kind, placedInService, basis, method).
- carryforwards[]: NOL carryover schedules → 'nol'; capital loss carryover → 'capital_loss'; foreign tax credit carryover (Form 1118) → 'foreign_tax_credit'.
- electionsInEffect[]: visible elections only (e.g. LIFO, consolidated-group).`,
};
