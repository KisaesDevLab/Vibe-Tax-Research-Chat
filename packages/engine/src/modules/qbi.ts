// TP-4 — §199A qualified business income deduction. Per-business
// component: 20% of QBI, wage-limited (50% of W-2 wages — the 25%+UBIA
// prong is deferred per QUESTIONS.md) with the limit phased in across the
// OBBBA range above the taxable-income threshold; SSTB income phases out
// entirely across the same range. Overall cap: 20% of (taxable income
// before QBI − net capital gain). OBBBA minimum deduction applies when
// aggregate active QBI clears the floor. All cents.
import type { FilingStatus, TableSetPayload } from '@vibe/shared';
import { dollars, mulRate, clampMin0 } from '../money.js';

export interface QbiBusiness {
  qbi: number; // cents, may be ≤ 0
  w2Wages: number; // cents — employee + owner wages paid by the business
  sstb: boolean;
}

export function computeQbiDeduction(opts: {
  businesses: QbiBusiness[];
  taxableIncomeBeforeQbi: number;
  netCapitalGain: number; // qualified dividends + net LTCG
  filingStatus: FilingStatus;
  t: TableSetPayload['qbi'];
}): number {
  const { businesses, taxableIncomeBeforeQbi, netCapitalGain, filingStatus, t } = opts;
  if (businesses.length === 0) return 0;

  const threshold = dollars(t.threshold[filingStatus]);
  const range = dollars(t.phaseInRange[filingStatus]);
  const over = clampMin0(taxableIncomeBeforeQbi - threshold);
  /** 0 below the threshold → 1 at/above the top of the range. */
  const phaseRatio = range === 0 ? 1 : Math.min(1, over / range);

  let combined = 0;
  let aggregateQbi = 0;
  for (const b of businesses) {
    aggregateQbi += b.qbi;
    if (b.qbi <= 0) {
      // Negative QBI reduces the combined amount at the 20% rate.
      combined += mulRate(b.qbi, t.rate);
      continue;
    }
    let qbi = b.qbi;
    if (b.sstb) {
      if (phaseRatio >= 1) continue; // fully phased out
      qbi = Math.round(qbi * (1 - phaseRatio));
    }
    const tentative = mulRate(qbi, t.rate);
    if (phaseRatio <= 0) {
      combined += tentative;
      continue;
    }
    // Wage limit phases in: below the threshold it doesn't bind at all;
    // inside the range only the phased portion of the shortfall applies.
    let wages = b.w2Wages;
    if (b.sstb) wages = Math.round(wages * (1 - phaseRatio));
    const wageLimit = mulRate(wages, 0.5);
    const shortfall = clampMin0(tentative - wageLimit);
    combined += tentative - Math.round(shortfall * phaseRatio);
  }

  const overallCap = mulRate(clampMin0(taxableIncomeBeforeQbi - netCapitalGain), t.rate);

  if (combined <= 0) {
    // OBBBA §199A(i): minimum deduction for taxpayers with modest active
    // QBI — still bounded by the overall 20%-of-(TI − net capital gain)
    // cap, same as the positive-combined branch.
    if (aggregateQbi >= dollars(t.minDeduction.qbiFloor)) {
      return Math.min(dollars(t.minDeduction.amount), overallCap);
    }
    return 0;
  }
  let deduction = Math.min(combined, overallCap);
  if (aggregateQbi >= dollars(t.minDeduction.qbiFloor)) {
    deduction = Math.max(deduction, Math.min(dollars(t.minDeduction.amount), overallCap));
  }
  return deduction;
}
