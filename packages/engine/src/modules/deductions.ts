// TP-4 — SALT (with the OBBBA cap phase-down) and itemized-vs-standard.
// All cents.
import type { FilingStatus, TableSetPayload } from '@vibe/shared';
import { dollars, mulRate, clampMin0 } from '../money.js';

export interface ItemizedInput {
  stateLocalTaxesPaid: number; // cents
  mortgageInterest: number;
  charitable: number;
  other: number;
}

export interface DeductionResult {
  saltDeducted: number;
  itemizedTotal: number;
  standardDeduction: number;
  usedItemized: boolean;
  deduction: number;
}

export function computeSaltCap(
  magi: number,
  filingStatus: FilingStatus,
  t: TableSetPayload['salt'],
): number {
  const cap = dollars(t.cap[filingStatus]);
  const floor = dollars(t.phaseDown.floor[filingStatus]);
  const threshold = dollars(t.phaseDown.magiThreshold[filingStatus]);
  const reduction = mulRate(clampMin0(magi - threshold), t.phaseDown.reductionRate);
  return Math.max(floor, cap - reduction);
}

export function computeDeduction(opts: {
  itemized: ItemizedInput;
  magi: number;
  filingStatus: FilingStatus;
  t: TableSetPayload;
}): DeductionResult {
  const { itemized, magi, filingStatus, t } = opts;
  const effectiveCap = computeSaltCap(magi, filingStatus, t.salt);
  const saltDeducted = Math.min(clampMin0(itemized.stateLocalTaxesPaid), effectiveCap);
  const itemizedTotal =
    saltDeducted +
    clampMin0(itemized.mortgageInterest) +
    clampMin0(itemized.charitable) +
    clampMin0(itemized.other);
  const standardDeduction = dollars(t.standardDeduction[filingStatus]);
  const usedItemized = itemizedTotal > standardDeduction;
  return {
    saltDeducted,
    itemizedTotal,
    standardDeduction,
    usedItemized,
    deduction: usedItemized ? itemizedTotal : standardDeduction,
  };
}
