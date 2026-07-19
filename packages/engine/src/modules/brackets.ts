// TP-4 — ordinary bracket tax + preferential-rate stacking. Qualified
// dividends and net LTCG stack ON TOP of ordinary taxable income: each
// preferential bracket layer is measured against total taxable income,
// so preferential dollars fill from where ordinary income ends. All cents.
import type { BracketRow } from '@vibe/shared';
import { dollars, mulRate, clampMin0 } from '../money.js';

/** Tax an amount through a bracket table (ceilings in whole dollars). */
export function taxFromBrackets(taxable: number, rows: BracketRow[]): number {
  if (taxable <= 0) return 0;
  let tax = 0;
  let lower = 0;
  for (const row of rows) {
    const upper = row.upTo === null ? Number.POSITIVE_INFINITY : dollars(row.upTo);
    if (taxable <= lower) break;
    const inBracket = Math.min(taxable, upper) - lower;
    if (inBracket > 0) tax += mulRate(inBracket, row.rate);
    lower = upper;
  }
  return tax;
}

/**
 * Preferential-rate tax on `prefIncome` stacked on top of
 * `ordinaryTaxable`. Bracket ceilings are total-taxable-income ceilings.
 */
export function taxPreferential(
  prefIncome: number,
  ordinaryTaxable: number,
  rows: BracketRow[],
): number {
  if (prefIncome <= 0) return 0;
  let tax = 0;
  let layerStart = clampMin0(ordinaryTaxable);
  const top = ordinaryTaxable + prefIncome;
  for (const row of rows) {
    const upper = row.upTo === null ? Number.POSITIVE_INFINITY : dollars(row.upTo);
    if (layerStart >= top) break;
    const layerEnd = Math.min(upper, top);
    if (layerEnd > layerStart) {
      tax += mulRate(layerEnd - layerStart, row.rate);
      layerStart = layerEnd;
    }
  }
  return tax;
}
