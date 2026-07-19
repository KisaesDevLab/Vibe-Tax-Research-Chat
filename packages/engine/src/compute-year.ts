// TP-4 — the year orchestrator. Deterministic, pure, zero I/O: every
// constant comes from the injected TableSetPayload, every dollar figure
// is computed in integer cents and rounded to whole dollars only at the
// YearResult boundary.
//
// v1 simplifications (QUESTIONS.md "Engine v1 simplifications"):
//   MAGI = AGI; §469 phase-out MAGI proxy = AGI before passive losses;
//   PTET = entity-level deduction pro-rata across pass-through income +
//   dollar-for-dollar credit against the flat-state liability; state
//   taxable base = federal AGI. Deferred: AMT, refundable ACTC, UBIA,
//   §461(l), non-flat states, OBBBA 2/37 itemized haircut.
import type { BaselineProfile, CarryforwardState, TableSetPayload, YearResult } from '@vibe/shared';
import { dollars, toDollars, mulRate, clampMin0 } from './money.js';
import { netCapital } from './modules/capital.js';
import {
  computeSeTax,
  computeAdditionalMedicare,
  computeOwnerPayrollTax,
} from './modules/se-tax.js';
import { computePassive } from './modules/passive.js';
import { computeQbiDeduction, type QbiBusiness } from './modules/qbi.js';
import { computeDeduction } from './modules/deductions.js';
import { taxFromBrackets, taxPreferential } from './modules/brackets.js';
import { computeCtc } from './modules/credits.js';

export interface ComputeYearOutput {
  result: YearResult;
  carryOut: CarryforwardState;
}

export function computeYear(
  profile: BaselineProfile,
  tableSet: TableSetPayload,
  carryIn: CarryforwardState,
  year: number,
): ComputeYearOutput {
  const fs = profile.filingStatus;
  const notes: string[] = [];

  // ── Wages and business flow-through ──
  const outsideWages = dollars(profile.wages);
  const ownerWagesTotal = profile.businesses.reduce((a, b) => a + dollars(b.ownerWages), 0);
  const w2Wages = outsideWages + ownerWagesTotal;

  // Owner payroll tax (both halves) on owner W-2 comp; the employer half
  // reduces the entity's flow-through income.
  const ownerPayroll = computeOwnerPayrollTax(ownerWagesTotal, outsideWages, tableSet.seTax);

  // PTET is an entity-level deduction: allocate pro-rata across positive
  // pass-through flow-through income before computing SE/QBI bases.
  const ptetPaid = dollars(profile.ptetPaid);
  const preFlow = profile.businesses.map((b) => {
    let flow = dollars(b.netProfit);
    if (b.kind === 's-corp') flow -= dollars(b.ownerWages);
    return { b, flow };
  });
  // The employer half of owner FICA is borne by the paying entity.
  if (ownerPayroll.employerHalf > 0) {
    const wagePayers = preFlow.filter((x) => dollars(x.b.ownerWages) > 0);
    const totalOwnerWages = wagePayers.reduce((a, x) => a + dollars(x.b.ownerWages), 0);
    for (const x of wagePayers) {
      x.flow -= Math.round((ownerPayroll.employerHalf * dollars(x.b.ownerWages)) / totalOwnerWages);
    }
  }
  // PTET is an ENTITY-level election: only pass-through entities (S corps,
  // partnerships) can make it, so the entity deduction is allocated
  // pro-rata across their positive flows only. A Schedule C cannot elect
  // PTET and must never see its SE base shrink from someone else's PTET.
  const electable = preFlow.filter((x) => x.b.kind === 's-corp' || x.b.kind === 'partnership');
  const electablePositiveTotal = electable.reduce((a, x) => a + clampMin0(x.flow), 0);
  let flows = preFlow.map((x) => {
    if (ptetPaid <= 0 || electablePositiveTotal <= 0 || x.flow <= 0 || x.b.kind === 'schedule-c') {
      return x;
    }
    return { ...x, flow: x.flow - Math.round((ptetPaid * x.flow) / electablePositiveTotal) };
  });
  if (ptetPaid > 0 && electablePositiveTotal <= 0) {
    if (electable.length > 0) {
      // Loss-year election: PTET paid by an entity with no positive flow
      // deepens the pass-through loss — the federal deduction must not
      // silently vanish. Allocate to an S corp first (an S-corp loss has
      // no SE-base effect, the conservative choice), else a partnership.
      const target =
        electable.find((x) => x.b.kind === 's-corp') ??
        electable.find((x) => x.b.kind === 'partnership')!;
      flows = flows.map((x) => (x.b === target.b ? { ...x, flow: x.flow - ptetPaid } : x));
      notes.push(
        `PTET deduction allocated to ${target.b.name} despite a loss year — it deepens the pass-through loss.`,
      );
    } else {
      notes.push(
        'PTET paid but no S-corp/partnership flow to deduct it against — federal entity deduction not modeled.',
      );
    }
  }
  const flowThroughTotal = flows.reduce((a, x) => a + x.flow, 0);

  // ── SE tax (Schedule C + partnership flow-through) ──
  const seIncome = flows
    .filter((x) => x.b.kind === 'schedule-c' || x.b.kind === 'partnership')
    .reduce((a, x) => a + x.flow, 0);
  const se = computeSeTax(seIncome, w2Wages, tableSet.seTax);
  const additionalMedicare = computeAdditionalMedicare(
    w2Wages,
    se.netEarnings,
    tableSet.seTax.addlMedicareThreshold[fs],
    tableSet.seTax.addlMedicareRate,
  );

  // ── Capital netting ──
  const capital = netCapital(
    dollars(profile.shortTermCapGain),
    dollars(profile.longTermCapGain),
    dollars(carryIn.capitalLossCarryforward),
  );

  // ── Income before passive ──
  const investmentIncome =
    dollars(profile.interestIncome) +
    dollars(profile.ordinaryDividends) +
    dollars(profile.qualifiedDividends);
  const incomeExPassive =
    w2Wages +
    flowThroughTotal +
    investmentIncome +
    capital.ordinaryComponent +
    capital.preferentialGain +
    dollars(profile.otherIncome);

  const aboveTheLine =
    se.deduction +
    dollars(profile.adjustments) +
    dollars(profile.seHealthInsurance) +
    dollars(profile.retirementContributions) +
    dollars(profile.hsaContribution);

  // §469 MAGI proxy: AGI computed before passive losses. Carry state is
  // whole dollars on the wire — convert to cents at the boundary.
  const magiExPassive = incomeExPassive - aboveTheLine;
  const suspendedInCents = Object.fromEntries(
    Object.entries(carryIn.passiveByActivity).map(([k, v]) => [k, dollars(v)]),
  );
  const passive = computePassive(
    profile.rentals,
    suspendedInCents,
    magiExPassive,
    tableSet.passive,
  );

  const totalIncome = incomeExPassive + passive.includedIncome;
  const agi = totalIncome - aboveTheLine;
  const magi = agi; // simplification per QUESTIONS.md

  // ── Deductions ──
  const ded = computeDeduction({
    itemized: {
      stateLocalTaxesPaid: dollars(profile.itemized.stateLocalTaxesPaid),
      mortgageInterest: dollars(profile.itemized.mortgageInterest),
      charitable: dollars(profile.itemized.charitable),
      other: dollars(profile.itemized.other),
    },
    magi,
    filingStatus: fs,
    t: tableSet,
  });
  const tiBeforeQbi = clampMin0(agi - ded.deduction);

  // ── §199A ──
  // QBI per business: flow-through reduced (at aggregate) by the SE-tax
  // deduction, SE health insurance, and SE retirement attributable to the
  // business — applied pro-rata across positive QBI businesses.
  const seLevelReductions =
    se.deduction + dollars(profile.seHealthInsurance) + dollars(profile.retirementContributions);
  const qbiEligibleFlows = flows.filter((x) => x.b.qbiEligible);
  const positiveQbiTotal = qbiEligibleFlows.reduce((a, x) => a + clampMin0(x.flow), 0);
  const qbiBusinesses: QbiBusiness[] = qbiEligibleFlows.map((x) => {
    let qbi = x.flow;
    if (qbi > 0 && positiveQbiTotal > 0 && seLevelReductions > 0) {
      // Only SE businesses bear SE-level reductions.
      if (x.b.kind === 'schedule-c' || x.b.kind === 'partnership') {
        const seFlowTotal = qbiEligibleFlows
          .filter((y) => y.b.kind === 'schedule-c' || y.b.kind === 'partnership')
          .reduce((a, y) => a + clampMin0(y.flow), 0);
        if (seFlowTotal > 0) {
          qbi -= Math.round((seLevelReductions * clampMin0(x.flow)) / seFlowTotal);
        }
      }
    }
    return {
      qbi,
      w2Wages: dollars(x.b.employeeWages) + dollars(x.b.ownerWages),
      sstb: x.b.sstb,
    };
  });
  const aggregateQbiReduction = dollars(profile.qbiReduction);
  if (aggregateQbiReduction !== 0 && qbiBusinesses.length > 0) {
    // The qbiReduction hook lands on the largest positive component.
    const target = qbiBusinesses.reduce((best, b) => (b.qbi > best.qbi ? b : best));
    target.qbi -= aggregateQbiReduction;
  }
  const qbiDeduction = computeQbiDeduction({
    businesses: qbiBusinesses,
    taxableIncomeBeforeQbi: tiBeforeQbi,
    netCapitalGain: capital.netCapitalGain + dollars(profile.qualifiedDividends),
    filingStatus: fs,
    t: tableSet.qbi,
  });

  const taxableIncome = clampMin0(tiBeforeQbi - qbiDeduction);

  // ── Tax ──
  const preferentialIncome = Math.min(
    capital.preferentialGain + dollars(profile.qualifiedDividends),
    taxableIncome,
  );
  const ordinaryTaxable = taxableIncome - preferentialIncome;
  const ordinaryTax = taxFromBrackets(ordinaryTaxable, tableSet.brackets[fs]);
  const capitalGainsTax = taxPreferential(
    preferentialIncome,
    ordinaryTaxable,
    tableSet.capitalGainsBrackets[fs],
  );
  const incomeTaxBeforeCredits = ordinaryTax + capitalGainsTax;

  const ctc = computeCtc({
    dependentsUnder17: profile.dependentsUnder17,
    otherDependents: profile.otherDependents,
    magi,
    filingStatus: fs,
    taxBeforeCredits: incomeTaxBeforeCredits,
    t: tableSet.ctc,
  });
  const otherCredits = Math.min(
    dollars(profile.otherCredits),
    clampMin0(incomeTaxBeforeCredits - ctc),
  );
  const incomeTax = clampMin0(incomeTaxBeforeCredits - ctc - otherCredits);

  // ── NIIT ──
  const nii =
    investmentIncome +
    clampMin0(capital.ordinaryComponent) +
    capital.preferentialGain +
    passive.passiveIncomeForNiit;
  const niit = mulRate(
    Math.min(clampMin0(nii), clampMin0(magi - dollars(tableSet.niit.magiThreshold[fs]))),
    tableSet.niit.rate,
  );

  // ── State (flat) + PTET credit ──
  let stateTax = 0;
  let ptetCredit = 0;
  if (profile.state && profile.state.flatRate > 0) {
    const gross = mulRate(clampMin0(agi), profile.state.flatRate);
    ptetCredit = Math.min(gross, ptetPaid);
    stateTax = gross - ptetCredit;
  } else if (ptetPaid > 0) {
    notes.push('PTET paid but no flat-state model configured — credit not applied.');
  }

  const corpTaxPaid = dollars(profile.corpTaxPaid);
  const otherTaxes = dollars(profile.otherTaxes);
  // ptetPaid is real cash out the door at the entity — it belongs in the
  // burden. The owner-level credit already reduced stateTax, so the PTET
  // election's honest benefit is the federal deduction, never the state
  // tax itself.
  const totalBurden =
    incomeTax +
    se.seTax +
    additionalMedicare +
    niit +
    ownerPayroll.total +
    stateTax +
    ptetPaid +
    corpTaxPaid +
    otherTaxes;

  const payments = dollars(profile.withholding) + dollars(profile.estimatedPayments);

  const result: YearResult = {
    year,
    seTax: toDollars(se.seTax),
    seTaxDeduction: toDollars(se.deduction),
    ownerPayrollTax: toDollars(ownerPayroll.total),
    additionalMedicare: toDollars(additionalMedicare),
    passiveAllowedLoss: toDollars(passive.allowedLoss),
    passiveSuspended: toDollars(passive.totalSuspended),
    totalIncome: toDollars(totalIncome),
    agi: toDollars(agi),
    magi: toDollars(magi),
    itemizedTotal: toDollars(ded.itemizedTotal),
    saltDeducted: toDollars(ded.saltDeducted),
    standardDeduction: toDollars(ded.standardDeduction),
    usedItemized: ded.usedItemized,
    qbiDeduction: toDollars(qbiDeduction),
    taxableIncome: toDollars(taxableIncome),
    ordinaryTax: toDollars(ordinaryTax),
    capitalGainsTax: toDollars(capitalGainsTax),
    incomeTaxBeforeCredits: toDollars(incomeTaxBeforeCredits),
    ctc: toDollars(ctc),
    otherCredits: toDollars(otherCredits),
    incomeTax: toDollars(incomeTax),
    niit: toDollars(niit),
    stateTax: toDollars(stateTax),
    ptetCredit: toDollars(ptetCredit),
    corpTaxPaid: toDollars(corpTaxPaid),
    otherTaxes: toDollars(otherTaxes),
    totalBurden: toDollars(totalBurden),
    payments: toDollars(payments),
    balanceDue: toDollars(totalBurden - payments),
    notes,
  };

  return {
    result,
    carryOut: {
      passiveByActivity: Object.fromEntries(
        Object.entries(passive.suspendedOut)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => [k, toDollars(v)]),
      ),
      capitalLossCarryforward: toDollars(capital.carryforwardOut),
    },
  };
}
