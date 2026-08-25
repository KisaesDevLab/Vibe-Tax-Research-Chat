import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'f1120s',
  maxPages: 10,
  systemGuide: `Form 1120-S (S corporation return). Pull:
- entity.type 's_corp'; entity.sCorpEffectiveDate from item E "Date of S election"; entity.formationState from item B/state line if shown; entity.fiscalYearEnd from the tax-year header when fiscal; entity.accountingMethod from Schedule B question 1.
- ownership[]: one entry per Schedule K-1 recipient summarized on Schedule B-1 or the K-1 count (item I "Number of shareholders"); when individual shareholder detail is visible use initials only for owner, pct from stock ownership percentages, role 'shareholder'. Mark relatedParty true when Schedule B-1 shows family attribution.
- electionsInEffect[]: code 's_election' with since = year of the S election date.
- income.characters: 'k1_active' (owner-operator presumption) and others evidenced by the return.
- stateFootprint[]: state of the address block (nexusBasis 'physical'); states listed on Schedule K state-apportionment attachments add entries (nexusBasis 'economic' unless payroll/property factors shown).
- property[]: Form 4562 / depreciation schedule rows — kind from the description (buildings → 'commercial' or 'residential_rental', autos → 'vehicle', machinery → 'equipment'), placedInService, basis (cost), method (MACRS/SL/bonus/179).
- carryforwards[]: any NOL or credit carryforward statements.
Disambiguation: officer compensation (line 7) is evidence of wages paid, not an ownership entry by itself.`,
};
