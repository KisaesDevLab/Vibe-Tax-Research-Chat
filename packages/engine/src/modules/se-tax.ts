// TP-4 — self-employment tax with Social Security wage-base coordination
// against W-2 wages (§1402(b): the SS-taxable portion of SE earnings is
// capped at the wage base REMAINING after W-2 social security wages).
// All cents.
import type { TableSetPayload } from '@vibe/shared';
import { mulRate, clampMin0 } from '../money.js';

export interface SeTaxResult {
  netEarnings: number; // SE earnings × 92.35%
  seTax: number;
  deduction: number; // ½ SE tax, above the line
}

export function computeSeTax(
  seIncome: number,
  w2SsWages: number,
  t: TableSetPayload['seTax'],
): SeTaxResult {
  if (seIncome <= 0) return { netEarnings: 0, seTax: 0, deduction: 0 };
  const netEarnings = mulRate(seIncome, t.netEarningsFactor);
  const remainingBase = clampMin0(t.ssWageBase * 100 - w2SsWages);
  const ssTaxable = Math.min(netEarnings, remainingBase);
  const ss = mulRate(ssTaxable, t.ssRate);
  const medicare = mulRate(netEarnings, t.medicareRate);
  const seTax = ss + medicare;
  return { netEarnings, seTax, deduction: Math.round(seTax / 2) };
}

/**
 * §3101(b)(2) Additional Medicare — 0.9% on Medicare wages + SE net
 * earnings over the filing-status threshold (individual side only).
 */
export function computeAdditionalMedicare(
  medicareWages: number,
  seNetEarnings: number,
  thresholdDollars: number,
  rate: number,
): number {
  const base = clampMin0(medicareWages + seNetEarnings - thresholdDollars * 100);
  return mulRate(base, rate);
}

/**
 * Owner W-2 payroll tax — BOTH halves of FICA on owner wages, surfaced as
 * a burden line (the S-corp side cost of reasonable comp). SS portion is
 * capped by the wage base remaining after outside W-2 wages.
 */
export function computeOwnerPayrollTax(
  ownerWages: number,
  outsideW2Wages: number,
  t: TableSetPayload['seTax'],
): { total: number; employerHalf: number } {
  if (ownerWages <= 0) return { total: 0, employerHalf: 0 };
  const remainingBase = clampMin0(t.ssWageBase * 100 - outsideW2Wages);
  const ssTaxable = Math.min(ownerWages, remainingBase);
  const ss = mulRate(ssTaxable, t.ssRate);
  const medicare = mulRate(ownerWages, t.medicareRate);
  const total = ss + medicare;
  return { total, employerHalf: Math.round(total / 2) };
}
