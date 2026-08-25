import type { ExtractionProtocol } from './types.js';

export const protocol: ExtractionProtocol = {
  docType: 'state_return',
  maxPages: 8,
  systemGuide: `State income tax return (any state). Pull:
- stateFootprint[]: the filing state (nexusBasis 'domicile' for a resident return, 'other' for nonresident/part-year — the form title says which). ptetElected true when the return or its attachments show a pass-through entity tax election or PTET credit claimed; false only when the form explicitly declines it; omit otherwise.
- electionsInEffect[]: a PTET election evidenced here → code 'ptet_<STATE>' (two-letter code), since = tax year.
- household.filingStatus only when it differs from federal (rare) — otherwise skip.
- carryforwards[]: state NOL or credit carryforward schedules → matching type with a display note naming the state.
Disambiguation: composite or withholding returns filed by an entity for owners are NOT the client's own footprint unless the client is the entity.`,
};
