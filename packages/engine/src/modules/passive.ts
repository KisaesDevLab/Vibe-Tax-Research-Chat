// TP-4 — §469 passive activity handling for rentals. Per QUESTIONS.md the
// MAGI proxy for the §469(i) allowance phase-out is AGI computed before
// passive losses. Suspended losses carry per activity: prior suspension
// releases against the same activity's income first; the active-
// participation allowance then absorbs up to $25k (phased out 50¢ per
// dollar of MAGI over the start threshold); the remainder suspends,
// allocated pro-rata across loss activities. All cents.
import type { RentalProfile, TableSetPayload } from '@vibe/shared';
import { dollars, clampMin0 } from '../money.js';

export interface PassiveResult {
  /** Net rental amount included in income (may be negative up to allowance). */
  includedIncome: number;
  allowedLoss: number; // positive number, magnitude of loss allowed
  suspendedOut: Record<string, number>; // positive amounts
  totalSuspended: number;
  /** Positive passive income for the NIIT base. */
  passiveIncomeForNiit: number;
}

export function computePassive(
  rentals: RentalProfile[],
  suspendedIn: Record<string, number>,
  magiExPassive: number,
  t: TableSetPayload['passive'],
): PassiveResult {
  if (rentals.length === 0) {
    return {
      includedIncome: 0,
      allowedLoss: 0,
      suspendedOut: { ...suspendedIn },
      totalSuspended: Object.values(suspendedIn).reduce((a, b) => a + b, 0),
      passiveIncomeForNiit: 0,
    };
  }

  // Step 1: release prior suspension against the same activity's income.
  const effective: Array<{ id: string; amount: number; active: boolean }> = [];
  const remainingSuspension: Record<string, number> = { ...suspendedIn };
  for (const r of rentals) {
    const cents = dollars(r.netIncome);
    const prior = remainingSuspension[r.id] ?? 0;
    if (cents > 0 && prior > 0) {
      const release = Math.min(cents, prior);
      remainingSuspension[r.id] = prior - release;
      effective.push({ id: r.id, amount: cents - release, active: r.activeParticipant });
    } else {
      effective.push({ id: r.id, amount: cents, active: r.activeParticipant });
    }
  }

  // Step 2: cross-net income against losses (passive income frees passive loss).
  const totalEffective = effective.reduce((a, e) => a + e.amount, 0);

  if (totalEffective >= 0) {
    return {
      includedIncome: totalEffective,
      allowedLoss: 0,
      suspendedOut: remainingSuspension,
      totalSuspended: Object.values(remainingSuspension).reduce((a, b) => a + b, 0),
      passiveIncomeForNiit: totalEffective,
    };
  }

  // Net passive loss. Active-participation allowance, phased out 50% of
  // MAGI over the start threshold.
  const netLoss = -totalEffective; // positive
  const phaseOutReduction = Math.round(clampMin0(magiExPassive - dollars(t.phaseOutStart)) / 2);
  const allowanceCap = clampMin0(dollars(t.rentalLossAllowance) - phaseOutReduction);
  // Only losses from active-participation activities qualify for the allowance.
  const activeLoss = effective
    .filter((e) => e.amount < 0 && e.active)
    .reduce((a, e) => a - e.amount, 0);
  const allowanceUsable = Math.min(netLoss, activeLoss, allowanceCap);

  const newlySuspended = netLoss - allowanceUsable;

  // Allocate the suspension pro-rata across loss activities.
  const lossActivities = effective.filter((e) => e.amount < 0);
  const totalLossMagnitude = lossActivities.reduce((a, e) => a - e.amount, 0);
  const suspendedOut: Record<string, number> = { ...remainingSuspension };
  if (newlySuspended > 0 && totalLossMagnitude > 0) {
    let assigned = 0;
    for (let i = 0; i < lossActivities.length; i++) {
      const e = lossActivities[i]!;
      const share =
        i === lossActivities.length - 1
          ? newlySuspended - assigned
          : Math.round((newlySuspended * -e.amount) / totalLossMagnitude);
      suspendedOut[e.id] = (suspendedOut[e.id] ?? 0) + share;
      assigned += share;
    }
  }

  return {
    includedIncome: -allowanceUsable,
    allowedLoss: allowanceUsable,
    suspendedOut,
    totalSuspended: Object.values(suspendedOut).reduce((a, b) => a + b, 0),
    // In a net-loss year every dollar of passive income was absorbed by
    // passive losses — nothing reaches the NIIT base.
    passiveIncomeForNiit: 0,
  };
}
