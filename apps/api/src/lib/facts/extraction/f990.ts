import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'f990',
  maxPages: 12,
  systemGuide: `Form 990 (exempt organization return). Pull:
- entity.type 'nonprofit'; formationState from the header/state of legal domicile (Part VI); fiscalYearEnd from the tax-year header; accountingMethod from Part XII line 1.
- ownership[]: officers/directors from Part VII as role labels ONLY (e.g. "President", "Treasurer") — role 'officer' or 'trustee', pct 0, never names.
- stateFootprint[]: state of domicile (nexusBasis 'domicile'); states listed in Schedule O / registration disclosures add entries (nexusBasis 'other').
- income.characters: 'other'; income.sources[] from Part VIII revenue categories (program service, contributions, investment) with approxBand.
- property[]: Part X land/buildings/equipment lines where a depreciation schedule is attached.
- openQuestions[]: UBI (Part V line 3) present → question about Form 990-T filing, raisedBy 'system', status 'open'.`,
};
