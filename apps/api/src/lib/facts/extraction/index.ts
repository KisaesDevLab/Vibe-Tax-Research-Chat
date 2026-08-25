// TP-3a — per-form extraction protocols (in-repo stand-in for the
// tax-planning-fact-pattern skill's extraction/ directory). Null for
// docTypes with nothing structured to extract.
import type { ClientDocType } from '@vibe/shared';
import type { ExtractionProtocol } from './types.js';
import { protocol as f1040 } from './f1040.js';
import { protocol as f1120s } from './f1120s.js';
import { protocol as f1120 } from './f1120.js';
import { protocol as f1065 } from './f1065.js';
import { protocol as k1 } from './k1.js';
import { protocol as f990 } from './f990.js';
import { protocol as stateReturn } from './state_return.js';

export type { ExtractionProtocol } from './types.js';

const PROTOCOLS: Partial<Record<ClientDocType, ExtractionProtocol>> = {
  f1040,
  f1120s,
  f1120,
  f1065,
  k1,
  f990,
  state_return: stateReturn,
};

export function getExtractionProtocol(docType: ClientDocType): ExtractionProtocol | null {
  return PROTOCOLS[docType] ?? null;
}
