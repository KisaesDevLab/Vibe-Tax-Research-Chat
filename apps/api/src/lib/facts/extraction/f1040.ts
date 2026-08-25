import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'f1040',
  maxPages: 12,
  systemGuide: `Form 1040 (individual return). Pull:
- household.filingStatus from the filing-status checkboxes at the top of page 1 (single/mfj/mfs/hoh; qualifying surviving spouse maps to null with a note in display).
- One household.dependents[] entry per row of the Dependents table: infer ageBand from the child tax credit / credit for other dependents checkboxes only (CTC box checked → '13_17' unless other evidence; never guess an exact age), relationship 'child' unless the relationship column says otherwise. NEVER emit dependent names.
- entity.type 'individual' (path entity.type) when no business schedules are present; if Schedule C is attached, also emit income.characters 'se'.
- income.characters from attached schedules: wages line → 'w2'; Schedule B interest/dividends → 'portfolio'; Schedule C → 'se'; Schedule D → 'capital_gain'; Schedule E page 1 → 'rental', page 2 K-1s → 'k1_active' or 'k1_passive' per the passive columns; IRA/pension lines → 'retirement'.
- income.sources[]: one entry per material source (label like "Schedule C consulting", approxBand from the line amount bands: under_100k / 100k_500k / 500k_1m / over_1m).
- stateFootprint[]: state from the address block (nexusBasis 'domicile'); any state return references add entries with nexusBasis 'other'.
- carryforwards[]: Schedule D line 16 loss with the carryover worksheet → type 'capital_loss'; NOL statement → 'nol'; Form 8801 → 'amt_credit'.
- electionsInEffect[]: visible elections only (e.g. Section 475(f) statement → code '475f').
Disambiguation: amounts on "line X" echoes in the left margin are line numbers, not values. Prefer the right-most amount on a row.`,
};
