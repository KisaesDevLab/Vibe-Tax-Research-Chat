// TP-7 — maps anchor hits into BaselineProfile fields with the master
// plan's disaggregation rules. NOTHING here persists — everything lands
// on the tie-out review screen and applies only after staff confirm.
// Deliberately NOT parsed: withholding/estimates (stale by planning
// time), dependents (manual).
import type { FilingStatus, TableSetPayload } from '@vibe/shared';
import type { AnchorHit } from './anchors.js';

export interface IntakeField {
  field: string;
  value: number;
  source: string; // page + matched label
}

export interface IntakeResult {
  vendor: string;
  fields: IntakeField[];
  filingStatus: FilingStatus | null;
  warnings: string[];
  /** The return's own totals, for the tie-out panel. */
  tieOut: {
    agi: number | null;
    taxableIncome: number | null;
    totalTax: number | null;
    seTax: number | null;
  };
}

export function mapReturn(
  hits: AnchorHit[],
  vendor: string,
  tableSet: TableSetPayload,
): IntakeResult {
  const get = (field: string) => hits.find((h) => h.field === field);
  const val = (field: string) => get(field)?.value ?? null;
  const warnings: string[] = [];
  const fields: IntakeField[] = [];
  const push = (field: string, value: number, from: string) => {
    const hit = get(from);
    fields.push({
      field,
      value,
      source: hit ? `p${hit.page}: ${hit.label.slice(0, 60)}` : 'derived',
    });
  };

  // Direct lines.
  const wages = val('wages');
  if (wages !== null) push('wages', wages, 'wages');
  const interest = val('interestIncome');
  if (interest !== null) push('interestIncome', interest, 'interestIncome');
  const qualified = val('qualifiedDividends');
  const ordinary = val('ordinaryDividends');
  if (qualified !== null) push('qualifiedDividends', qualified, 'qualifiedDividends');
  if (ordinary !== null) {
    // 1040 line 3b is TOTAL ordinary dividends (includes qualified); the
    // profile wants the non-qualified remainder.
    const nonQualified = Math.max(ordinary - (qualified ?? 0), 0);
    push('ordinaryDividends', nonQualified, 'ordinaryDividends');
  }
  const schC = val('scheduleCNet');
  if (schC !== null) push('business.netProfit', schC, 'scheduleCNet');

  // Schedule E lines disaggregate Schedule 1 line 5.
  const rental = val('schERentalNet');
  const partnership = val('schEPartnershipNet');
  const sch1Line5 = val('schedule1Line5') ?? val('schETotal');
  if (rental !== null) push('rental.netIncome', rental, 'schERentalNet');
  if (partnership !== null) push('partnership.netProfit', partnership, 'schEPartnershipNet');
  if (sch1Line5 !== null && rental !== null && partnership !== null) {
    if (Math.abs(rental + partnership - sch1Line5) > 1) {
      warnings.push(
        `Schedule E pieces (${rental.toLocaleString()} + ${partnership.toLocaleString()}) don't tie to Schedule 1 line 5 (${sch1Line5.toLocaleString()}) — royalties/estates or a farm line may be in the gap.`,
      );
    }
  } else if (sch1Line5 !== null && (rental === null || partnership === null)) {
    warnings.push(
      'Schedule 1 line 5 present but Schedule E detail lines were not found — enter rental/partnership splits manually.',
    );
  }

  // Schedule D line 15 splits LT from the 1040 line 7 total; the ST
  // remainder goes to other income with a one-time-gain warning.
  const capTotal = val('capitalGain1040');
  const lt = val('schDLongTerm');
  const st = val('schDShortTerm');
  if (lt !== null) push('longTermCapGain', lt, 'schDLongTerm');
  if (st !== null && st !== 0) {
    push('shortTermCapGain', st, 'schDShortTerm');
    warnings.push(
      'Short-term gain detected — confirm whether it recurs before projecting it forward.',
    );
  }
  if (capTotal !== null && lt === null && st === null) {
    push('longTermCapGain', capTotal, 'capitalGain1040');
    warnings.push(
      'Schedule D detail not found; the 1040 line 7 total was assumed long-term — verify.',
    );
  }

  // Filing status inferred from the standard-deduction match.
  let filingStatus: FilingStatus | null = null;
  const std = val('standardDeduction');
  if (std !== null) {
    const entries = Object.entries(tableSet.standardDeduction) as Array<[FilingStatus, number]>;
    const exact = entries.filter(([, amount]) => amount === std).map(([fs]) => fs);
    if (exact.length === 1) filingStatus = exact[0]!;
    else if (exact.length > 1) {
      // single and mfs share an amount — leave for staff, but narrow it.
      warnings.push(
        `Standard deduction $${std.toLocaleString()} matches multiple statuses (${exact.join(', ')}) — pick manually.`,
      );
    } else {
      warnings.push(
        'Standard-deduction amount matches no 2026 filing status — likely itemized; set status manually.',
      );
    }
  }

  return {
    vendor,
    fields,
    filingStatus,
    warnings,
    tieOut: {
      agi: val('agi'),
      taxableIncome: val('taxableIncome'),
      totalTax: val('totalTax'),
      seTax: val('seTax'),
    },
  };
}
