// TP-12 — parameterized apply-module factories. Most modeled strategies
// are one of a handful of transform shapes (an entity-level deduction, an
// above-the-line adjustment, a credit, a retirement contribution, a
// rental deduction, a capital-gain reduction). Factories keep the 47
// TP-12 modules honest and tiny; anything genuinely structural stays a
// bespoke module in tp12-modules.ts.
import type { BusinessProfile, TableSetPayload } from '@vibe/shared';
import type { ApplyContext, ApplyFn, ApplyResult } from '../types.js';

export const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export type BusinessTarget = 'any' | 'entity' | 'schedule-c' | 's-corp';

/**
 * One-time transforms (asset placed in service, a study, a bunching
 * contribution, a write-off) act in YEAR ONE of the projection only.
 * Without this wrapper composeScenario re-applies the transform every
 * projection year, silently multiplying a one-shot deduction by the
 * plan's year count.
 */
export function oneShot(label: string, fn: ApplyFn): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    if (ctx.yearIndex > 0) {
      return {
        profile: ctx.profile,
        notes: [`${label}: year-one action — no additional deduction modeled in later years.`],
      };
    }
    return fn(ctx);
  };
}

export function findBusinessIndex(businesses: BusinessProfile[], target: BusinessTarget): number {
  switch (target) {
    case 'schedule-c':
      return businesses.findIndex((b) => b.kind === 'schedule-c');
    case 's-corp':
      return businesses.findIndex((b) => b.kind === 's-corp');
    case 'entity':
      return businesses.findIndex((b) => b.kind === 's-corp' || b.kind === 'partnership');
    case 'any':
      return businesses.length > 0 ? 0 : -1;
  }
}

interface EntityDeductionOpts {
  /** Params key holding the deduction amount (whole dollars). */
  param: string;
  target: BusinessTarget;
  label: string;
  /** Optional hard cap; may derive from the table set. */
  cap?: (ctx: ApplyContext) => number;
  /** Message when no eligible business exists. */
  missingNote: string;
}

/** Deduction at the business level: reduces netProfit (flows to SE/QBI). */
export function entityDeduction(opts: EntityDeductionOpts): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    const idx = findBusinessIndex(profile.businesses, opts.target);
    if (idx === -1) return { profile, notes: [opts.missingNote] };
    let amount = Math.max(num(params[opts.param]), 0);
    const notes: string[] = [];
    if (opts.cap) {
      const cap = opts.cap(ctx);
      if (amount > cap) {
        notes.push(`${opts.label}: requested ${usd(amount)} clamped to the ${usd(cap)} limit.`);
        amount = cap;
      }
    }
    if (amount <= 0) return { profile, notes: [`${opts.label}: no amount to deduct.`] };
    const businesses = profile.businesses.map((b, i) =>
      i === idx ? { ...b, netProfit: b.netProfit - amount } : b,
    );
    notes.push(`${opts.label}: ${usd(amount)} deducted at the entity level.`);
    return { profile: { ...profile, businesses }, notes };
  };
}

/** Above-the-line adjustment (reduces AGI, not SE income). */
export function aboveTheLine(opts: { param: string; label: string }): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const amount = Math.max(num(ctx.params[opts.param]), 0);
    if (amount <= 0) return { profile: ctx.profile, notes: [`${opts.label}: nothing to apply.`] };
    return {
      profile: { ...ctx.profile, adjustments: ctx.profile.adjustments + amount },
      notes: [`${opts.label}: ${usd(amount)} above the line.`],
    };
  };
}

/** Nonrefundable credit added to the otherCredits hook. */
export function credit(opts: {
  label: string;
  compute: (params: Record<string, unknown>, tableSet: TableSetPayload) => number;
  note?: (amount: number) => string;
}): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const amount = Math.max(Math.round(opts.compute(ctx.params, ctx.tableSet)), 0);
    if (amount <= 0) {
      return { profile: ctx.profile, notes: [`${opts.label}: no credit generated.`] };
    }
    return {
      profile: { ...ctx.profile, otherCredits: ctx.profile.otherCredits + amount },
      notes: [opts.note ? opts.note(amount) : `${opts.label}: ${usd(amount)} credit.`],
    };
  };
}

/** Traditional retirement contribution (above the line via the hook). */
export function retirementContribution(opts: {
  label: string;
  compute: (ctx: ApplyContext) => { amount: number; notes?: string[] };
}): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const { amount, notes = [] } = opts.compute(ctx);
    if (amount <= 0) {
      return {
        profile: ctx.profile,
        notes: [`${opts.label}: no contribution capacity.`, ...notes],
      };
    }
    return {
      profile: {
        ...ctx.profile,
        retirementContributions: ctx.profile.retirementContributions + amount,
      },
      notes: [`${opts.label}: ${usd(amount)} contributed pre-tax.`, ...notes],
    };
  };
}

/** Earned-income base available to employer retirement plans. */
export function retirementCompBase(ctx: ApplyContext): {
  seProfit: number;
  ownerWages: number;
} {
  const seProfit = ctx.profile.businesses
    .filter((b) => b.kind === 'schedule-c' || b.kind === 'partnership')
    .reduce((a, b) => a + Math.max(b.netProfit, 0), 0);
  const ownerWages = ctx.profile.businesses.reduce((a, b) => a + Math.max(b.ownerWages, 0), 0);
  return { seProfit, ownerWages };
}

/** Deduction against a rental activity (depreciation-type transforms). */
export function rentalDeduction(opts: {
  param: string;
  label: string;
  missingNote: string;
}): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    if (profile.rentals.length === 0) return { profile, notes: [opts.missingNote] };
    const amount = Math.max(num(params[opts.param]), 0);
    if (amount <= 0) return { profile, notes: [`${opts.label}: no amount to deduct.`] };
    const targetId = typeof params.rentalId === 'string' ? params.rentalId : profile.rentals[0]!.id;
    const idx = profile.rentals.findIndex((r) => r.id === targetId);
    if (idx === -1) {
      // Never silently retarget a different property — a stale rentalId
      // must surface, not shift depreciation onto the wrong activity.
      return { profile, notes: [`${opts.label}: rental "${targetId}" not found — not applied.`] };
    }
    const rentals = profile.rentals.map((r, i) =>
      i === idx ? { ...r, netIncome: r.netIncome - amount } : r,
    );
    return {
      profile: { ...profile, rentals },
      notes: [
        `${opts.label}: ${usd(amount)} of deductions against ${rentals[idx]!.name} — §469 passive limits apply through the engine.`,
      ],
    };
  };
}

/** Reduce recognized capital gain (deferral/exclusion strategies). */
export function capitalGainReduction(opts: {
  param: string;
  label: string;
  term: 'long' | 'short';
  cap?: (ctx: ApplyContext) => number;
}): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    const available = opts.term === 'long' ? profile.longTermCapGain : profile.shortTermCapGain;
    let amount = Math.min(Math.max(num(params[opts.param]), 0), Math.max(available, 0));
    const notes: string[] = [];
    if (opts.cap) {
      const cap = opts.cap(ctx);
      if (amount > cap) {
        notes.push(`${opts.label}: clamped to the ${usd(cap)} limit.`);
        amount = cap;
      }
    }
    if (amount <= 0) {
      return { profile, notes: [`${opts.label}: no recognized gain to offset.`] };
    }
    const next =
      opts.term === 'long'
        ? { ...profile, longTermCapGain: profile.longTermCapGain - amount }
        : { ...profile, shortTermCapGain: profile.shortTermCapGain - amount };
    notes.push(`${opts.label}: ${usd(amount)} of gain removed from the current year.`);
    return { profile: next, notes };
  };
}

/**
 * Installment recognition: year 0 pushes (years-1)/years of the gain out;
 * later projection years bring one tranche back in via carry state.
 */
export function installmentSpread(opts: {
  gainParam: string;
  yearsParam: string;
  label: string;
}): ApplyFn {
  return (ctx: ApplyContext): ApplyResult => {
    const { profile, params, yearIndex, carry } = ctx;
    const totalGain = Math.max(num(params[opts.gainParam]), 0);
    const years = Math.min(Math.max(Math.floor(num(params[opts.yearsParam], 5)), 2), 30);
    if (totalGain <= 0) return { profile, notes: [`${opts.label}: no gain to spread.`] };
    const tranche = Math.round(totalGain / years);
    if (yearIndex === 0) {
      const deferred = Math.min(totalGain - tranche, Math.max(profile.longTermCapGain, 0));
      return {
        profile: { ...profile, longTermCapGain: profile.longTermCapGain - deferred },
        notes: [
          `${opts.label}: ${usd(tranche)} recognized now; ${usd(deferred)} deferred across ${years - 1} later year(s). Interest income on the note is not modeled.`,
        ],
        carryPatch: { remaining: deferred, tranche },
      };
    }
    const remaining = Math.max(num(carry.remaining), 0);
    const trancheIn = Math.min(Math.max(num(carry.tranche), 0), remaining);
    if (trancheIn <= 0) return { profile, notes: [`${opts.label}: note fully recognized.`] };
    return {
      profile: { ...profile, longTermCapGain: profile.longTermCapGain + trancheIn },
      notes: [`${opts.label}: ${usd(trancheIn)} installment tranche recognized this year.`],
      carryPatch: { remaining: remaining - trancheIn, tranche: trancheIn },
    };
  };
}
