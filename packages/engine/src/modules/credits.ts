// TP-4 — child tax credit + other-dependent credit with MAGI phase-out
// ($X per $1,000 or fraction thereof over the threshold), nonrefundable
// (refundable ACTC deferred per QUESTIONS.md). All cents.
import type { FilingStatus, TableSetPayload } from '@vibe/shared';
import { dollars, clampMin0 } from '../money.js';

export function computeCtc(opts: {
  dependentsUnder17: number;
  otherDependents: number;
  magi: number;
  filingStatus: FilingStatus;
  taxBeforeCredits: number;
  t: TableSetPayload['ctc'];
}): number {
  const { dependentsUnder17, otherDependents, magi, filingStatus, taxBeforeCredits, t } = opts;
  const gross =
    dependentsUnder17 * dollars(t.perChild) + otherDependents * dollars(t.otherDependent);
  if (gross <= 0) return 0;
  const over = clampMin0(magi - dollars(t.phaseOutThreshold[filingStatus]));
  const steps = Math.ceil(over / dollars(1000));
  const reduction = steps * dollars(t.phaseOutPer1000);
  const credit = clampMin0(gross - reduction);
  return Math.min(credit, clampMin0(taxBeforeCredits));
}
