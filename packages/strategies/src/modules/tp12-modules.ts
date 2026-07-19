// TP-12 — apply modules for the remaining 47 modeled strategies. Most
// are factory instances (see factories/index.ts); the structural ones
// (entity conversion, recharacterizations, wage shifts) are bespoke.
// Every module is a pure profile transform — the engine does the math.
import type { BusinessProfile } from '@vibe/shared';
import type { ApplyContext, ApplyResult } from '../types.js';
import { register } from './index.js';
import {
  aboveTheLine,
  oneShot,
  capitalGainReduction,
  credit,
  entityDeduction,
  installmentSpread,
  num,
  rentalDeduction,
  retirementCompBase,
  retirementContribution,
  usd,
} from '../factories/index.js';

// ═══════════════════ Entity structure (band 10–19) ═══════════════════

// c-corp-conversion: the flow-through disappears from the 1040; the
// corporation pays 21% on retained profit; the owner reports W-2 salary
// and any dividends. Often INCREASES current burden — that is the honest
// story (mayIncreaseBurden: true in the record).
register('c-corp-conversion@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = profile.businesses.findIndex((b) => b.kind === 's-corp' || b.kind === 'schedule-c');
  if (idx === -1) return { profile, notes: ['No flow-through business to convert.'] };
  const target = profile.businesses[idx]!;
  const salary = Math.min(Math.max(num(params.salary), 0), Math.max(target.netProfit, 0));
  const corpProfit = Math.max(target.netProfit - salary, 0);
  const corpTax = Math.round(corpProfit * 0.21);
  const dividends = Math.min(Math.max(num(params.dividendDistribution), 0), corpProfit - corpTax);
  const businesses = profile.businesses.filter((_, i) => i !== idx);
  return {
    profile: {
      ...profile,
      businesses,
      wages: profile.wages + salary,
      qualifiedDividends: profile.qualifiedDividends + dividends,
      corpTaxPaid: profile.corpTaxPaid + corpTax,
    },
    notes: [
      `${target.name} converted to C corporation: ${usd(salary)} W-2 salary, ${usd(corpTax)} corporate tax on ${usd(corpProfit)} retained, ${usd(dividends)} qualified dividends distributed.`,
      'QBI on this income is forfeited; retained earnings face a second tax when distributed.',
    ],
  };
});

// qbi-aggregation: merge commonly-controlled S corporations so the
// §199A wage limit tests the combined wage base (Reg. §1.199A-4).
register('qbi-aggregation@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile } = ctx;
  const eligible = profile.businesses.filter(
    (b) => b.kind === 's-corp' && b.qbiEligible && !b.sstb,
  );
  if (eligible.length < 2) {
    return { profile, notes: ['Fewer than two aggregable S corporations — election not applied.'] };
  }
  const merged: BusinessProfile = {
    id: 'qbi-aggregated',
    name: `Aggregated (${eligible.map((b) => b.name).join(' + ')})`,
    kind: 's-corp',
    netProfit: eligible.reduce((a, b) => a + b.netProfit, 0),
    employeeWages: eligible.reduce((a, b) => a + b.employeeWages, 0),
    ownerWages: eligible.reduce((a, b) => a + b.ownerWages, 0),
    sstb: false,
    qbiEligible: true,
  };
  const businesses = [merged, ...profile.businesses.filter((b) => !eligible.includes(b))];
  return {
    profile: { ...profile, businesses },
    notes: [
      `§199A aggregation across ${eligible.length} S corporations — the wage limit now tests the combined ${usd(merged.employeeWages + merged.ownerWages)} wage base.`,
    ],
  };
});

// ═══════════════════ Compensation (band 20–29) ═══════════════════

// spouse-payroll: real wages to a spouse are FICA-taxed both halves, so
// the payroll math is near-neutral against SE tax — the payoff is the
// benefit doors it opens (retirement capacity, §105 MERP). Modeled
// honestly, so small positive deltas are possible.
register('spouse-payroll@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = profile.businesses.findIndex((b) => b.kind === 'schedule-c');
  if (idx === -1) {
    return { profile, notes: ['Spouse payroll is modeled for a Schedule C payor — not applied.'] };
  }
  const target = profile.businesses[idx]!;
  const wages = Math.min(Math.max(num(params.annualWages), 0), Math.max(target.netProfit, 0));
  if (wages <= 0) return { profile, notes: ['No wages configured — not applied.'] };
  const employerFica = Math.round(wages * 0.0765);
  const employeeFica = Math.round(wages * 0.0765);
  const businesses = profile.businesses.map((b, i) =>
    i === idx
      ? {
          ...b,
          netProfit: b.netProfit - wages - employerFica,
          employeeWages: b.employeeWages + wages,
        }
      : b,
  );
  return {
    profile: {
      ...profile,
      businesses,
      // Spouse W-2 income routes through otherIncome, NOT profile.wages:
      // the engine aggregates profile.wages into one household SS wage
      // base (documented v1 simplification), and letting spouse wages
      // shrink the owner's SE SS coordination would monetize that
      // simplification into phantom savings. FICA bases are per person.
      otherIncome: profile.otherIncome + wages,
      otherTaxes: profile.otherTaxes + employeeFica,
    },
    notes: [
      `Spouse on payroll at ${usd(wages)}: business deducts wages plus ${usd(employerFica)} employer FICA; ${usd(employeeFica)} employee FICA withheld. The payroll math is near-neutral — the value is the plans this W-2 unlocks.`,
    ],
  };
});

// qbi-wage-optimization: reset S-corp owner wages to the level that
// best trades payroll tax against the §199A wage limit.
register('qbi-wage-optimization@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = profile.businesses.findIndex((b) => b.kind === 's-corp');
  if (idx === -1) return { profile, notes: ['No S corporation — wage optimization not applied.'] };
  const target = profile.businesses[idx]!;
  const wages = Math.min(Math.max(num(params.targetOwnerWages), 0), Math.max(target.netProfit, 0));
  const businesses = profile.businesses.map((b, i) =>
    i === idx ? { ...b, ownerWages: wages } : b,
  );
  return {
    profile: { ...profile, businesses },
    notes: [
      `Owner W-2 reset from ${usd(target.ownerWages)} to ${usd(wages)} to optimize the §199A wage limit (reasonableness still governs the floor).`,
    ],
  };
});

// ═══════════════════ Deduction creation (band 30–49) ═══════════════════

register(
  'bad-debt-review@1.0.0',
  oneShot(
    'Bad-debt write-off',
    entityDeduction({
      param: 'worthlessAmount',
      target: 'any',
      label: 'Bad-debt write-off (§166)',
      missingNote: 'No business with receivables to review — not applied.',
    }),
  ),
);

// daf-bunching: several years of giving front-loaded into a donor-
// advised fund — an itemized charitable deduction, not a business one.
register(
  'daf-bunching@1.0.0',
  oneShot('DAF bunching', (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    const amount = Math.max(num(params.contribution), 0);
    if (amount <= 0) return { profile, notes: ['No DAF contribution configured.'] };
    return {
      profile: {
        ...profile,
        itemized: { ...profile.itemized, charitable: profile.itemized.charitable + amount },
      },
      notes: [
        `${usd(amount)} contributed to a donor-advised fund — deduction bunched into this year; grants to charities follow on the client's schedule. AGI percentage limits are reviewed outside the model.`,
      ],
    };
  }),
);

// heavy-vehicle-179: business-use share of a >6,000 lb GVWR vehicle.
register(
  'heavy-vehicle-179@1.0.0',
  oneShot('Heavy vehicle §179', (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    const idx = profile.businesses.length > 0 ? 0 : -1;
    if (idx === -1) return { profile, notes: ['No business to place the vehicle in service.'] };
    const cost = Math.max(num(params.vehicleCost), 0);
    const pct = Math.min(Math.max(num(params.businessUsePct, 100), 0), 100);
    const amount = Math.round((cost * pct) / 100);
    if (amount <= 0 || pct <= 50) {
      return {
        profile,
        notes: ['§179 on a listed vehicle requires >50% business use — not applied.'],
      };
    }
    const businesses = profile.businesses.map((b, i) =>
      i === idx ? { ...b, netProfit: b.netProfit - amount } : b,
    );
    return {
      profile: { ...profile, businesses },
      notes: [
        `Heavy vehicle (${usd(cost)} at ${pct}% business use): ${usd(amount)} expensed under §179/bonus in year one.`,
      ],
    };
  }),
);

// home-office-deduction: simplified ($5/sq ft, 300 cap) or actual.
register('home-office-deduction@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = profile.businesses.findIndex((b) => b.kind === 'schedule-c');
  if (idx === -1) {
    return {
      profile,
      notes: [
        'Home office is modeled for Schedule C — entity owners use an accountable plan instead.',
      ],
    };
  }
  const method = params.method === 'actual' ? 'actual' : 'simplified';
  const amount =
    method === 'simplified'
      ? Math.min(Math.max(Math.floor(num(params.squareFeet)), 0), 300) * 5
      : Math.max(num(params.actualExpenses), 0);
  const capped = Math.min(amount, Math.max(profile.businesses[idx]!.netProfit, 0));
  if (capped <= 0) return { profile, notes: ['No deductible home-office amount — not applied.'] };
  const businesses = profile.businesses.map((b, i) =>
    i === idx ? { ...b, netProfit: b.netProfit - capped } : b,
  );
  return {
    profile: { ...profile, businesses },
    notes: [
      `Home office (${method}): ${usd(capped)} deducted, limited to the business's net income.`,
    ],
  };
});

register(
  'meals-optimization@1.0.0',
  entityDeduction({
    param: 'additionalDeduction',
    target: 'any',
    label: 'Meals documentation upgrade (50% class)',
    missingNote: 'No business meals to recover — not applied.',
  }),
);

register(
  'personal-aircraft@1.0.0',
  entityDeduction({
    param: 'businessUseDeduction',
    target: 'any',
    label: 'Aircraft business-use deduction',
    missingNote: 'No business to bear the aircraft expense — not applied.',
  }),
);

register(
  'prepaid-expenses@1.0.0',
  oneShot(
    '12-month-rule prepayments',
    entityDeduction({
      param: 'prepaidAmount',
      target: 'any',
      label: '12-month-rule prepayments',
      missingNote: 'No cash-method business to accelerate deductions into — not applied.',
    }),
  ),
);

register(
  'vehicle-expense-method@1.0.0',
  entityDeduction({
    param: 'incrementalDeduction',
    target: 'any',
    label: 'Vehicle method switch (actual vs standard)',
    missingNote: 'No business vehicle use — not applied.',
  }),
);

// Health & fringe --------------------------------------------------------

// dependent-care-fsa: pre-tax election reduces W-2 box 1 (FICA relief
// exists too but W-2 FICA is outside the modeled burden).
register('dependent-care-fsa@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const capMfs = profile.filingStatus === 'mfs' ? 3750 : 7500;
  const amount = Math.min(Math.max(num(params.election), 0), capMfs, Math.max(profile.wages, 0));
  if (amount <= 0) {
    return {
      profile,
      notes: ['Dependent care FSA needs W-2 wages to elect against — not applied.'],
    };
  }
  return {
    profile: { ...profile, wages: profile.wages - amount },
    notes: [
      `${usd(amount)} of dependent-care FSA election excluded from W-2 wages (payroll-tax savings additional, outside the modeled burden).`,
    ],
  };
});

register(
  'ichra@1.0.0',
  entityDeduction({
    param: 'annualReimbursements',
    target: 'any',
    label: 'ICHRA reimbursements',
    missingNote: 'No employer to sponsor an ICHRA — not applied.',
  }),
);

register(
  'qsehra@1.0.0',
  entityDeduction({
    param: 'annualReimbursements',
    target: 'any',
    label: 'QSEHRA reimbursements',
    missingNote: 'No small employer to sponsor a QSEHRA — not applied.',
  }),
);

register(
  'section-105-merp@1.0.0',
  entityDeduction({
    param: 'reimbursedMedical',
    target: 'schedule-c',
    label: '§105 MERP (spouse employee)',
    missingNote: 'A §105 MERP needs a Schedule C payor employing the spouse — not applied.',
  }),
);

register(
  'section-127-education@1.0.0',
  entityDeduction({
    param: 'assistanceAmount',
    target: 'any',
    label: '§127 educational assistance',
    cap: (ctx) => 5250 * Math.max(1, Math.floor(num(ctx.params.participatingEmployees, 1))),
    missingNote: 'No employer to sponsor a §127 plan — not applied.',
  }),
);

// spouse-health-s-corp: premiums through the S corp — entity deducts,
// W-2 box 1 grosses up, §162(l) deducts above the line. Net effect: the
// premium becomes an entity-level deduction.
register('spouse-health-s-corp@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = profile.businesses.findIndex((b) => b.kind === 's-corp');
  if (idx === -1)
    return { profile, notes: ['No S corporation — 2% shareholder routing not applied.'] };
  const premium = Math.max(num(params.annualPremium), 0);
  if (premium <= 0) return { profile, notes: ['No premium configured — not applied.'] };
  const businesses = profile.businesses.map((b, i) =>
    i === idx ? { ...b, netProfit: b.netProfit - premium } : b,
  );
  return {
    profile: {
      ...profile,
      businesses,
      // Box-1-only inclusion (Announcement 92-16): the premium is NOT
      // FICA/Medicare wages, so it must not enter profile.wages (which
      // feeds the Additional-Medicare and SS wage-base coordination).
      // otherIncome is income-tax-equivalent without the payroll bases.
      otherIncome: profile.otherIncome + premium,
      seHealthInsurance: profile.seHealthInsurance + premium,
    },
    notes: [
      `${usd(premium)} of premiums run through the S corp: deducted by the entity, included in the 2% shareholder's Box 1 only (no FICA), then deducted above the line under §162(l).`,
    ],
  };
});

// Real estate & cost recovery -------------------------------------------

// bonus-depreciation / repair-vs-capitalization can target either a
// rental or an operating business.
function dualTargetDeduction(label: string, param: string) {
  return (ctx: ApplyContext): ApplyResult => {
    const { profile, params } = ctx;
    const amount = Math.max(num(params[param]), 0);
    if (amount <= 0) return { profile, notes: [`${label}: no amount configured.`] };
    const target = params.target === 'business' ? 'business' : 'rental';
    if (target === 'rental' && profile.rentals.length > 0) {
      const rentals = profile.rentals.map((r, i) =>
        i === 0 ? { ...r, netIncome: r.netIncome - amount } : r,
      );
      return {
        profile: { ...profile, rentals },
        notes: [`${label}: ${usd(amount)} against ${rentals[0]!.name} (§469 limits apply).`],
      };
    }
    if (profile.businesses.length === 0) {
      return { profile, notes: [`${label}: no rental or business to absorb the deduction.`] };
    }
    const businesses = profile.businesses.map((b, i) =>
      i === 0 ? { ...b, netProfit: b.netProfit - amount } : b,
    );
    return {
      profile: { ...profile, businesses },
      notes: [`${label}: ${usd(amount)} deducted by ${businesses[0]!.name}.`],
    };
  };
}

register(
  'bonus-depreciation@1.0.0',
  oneShot('Bonus depreciation', dualTargetDeduction('Bonus depreciation', 'deductionAmount')),
);
register(
  'repair-vs-capitalization@1.0.0',
  dualTargetDeduction('Repair expensing (TPR)', 'expensedAmount'),
);

register(
  'cost-segregation@1.0.0',
  oneShot(
    'Cost segregation',
    rentalDeduction({
      param: 'firstYearAcceleration',
      label: 'Cost segregation',
      missingNote: 'No rental property to study — not applied.',
    }),
  ),
);

register(
  'energy-179d@1.0.0',
  oneShot(
    '\u00a7179D deduction',
    entityDeduction({
      param: 'deductionAmount',
      target: 'any',
      label: '§179D energy-efficient building deduction',
      missingNote: 'No business owning or designing qualifying property — not applied.',
    }),
  ),
);

register(
  'installment-sale-property@1.0.0',
  installmentSpread({
    gainParam: 'totalGain',
    yearsParam: 'termYears',
    label: 'Installment sale (property)',
  }),
);

register(
  'land-building-allocation@1.0.0',
  rentalDeduction({
    param: 'additionalDepreciation',
    label: 'Land/building re-allocation',
    missingNote: 'No rental with basis to re-allocate — not applied.',
  }),
);

register(
  'like-kind-1031@1.0.0',
  capitalGainReduction({
    param: 'deferredGain',
    label: '§1031 exchange deferral',
    term: 'long',
  }),
);

register(
  'opportunity-zones@1.0.0',
  capitalGainReduction({
    param: 'investedGain',
    label: 'Opportunity-zone deferral',
    term: 'long',
  }),
);

register(
  'partial-asset-disposition@1.0.0',
  oneShot(
    'Partial asset disposition',
    rentalDeduction({
      param: 'remainingBasis',
      label: 'Partial asset disposition',
      missingNote: 'No rental with replaced components — not applied.',
    }),
  ),
);

register(
  'qip-bonus@1.0.0',
  oneShot(
    'QIP bonus depreciation',
    entityDeduction({
      param: 'qipDeduction',
      target: 'any',
      label: 'QIP bonus depreciation',
      missingNote: 'No business with qualified improvement property — not applied.',
    }),
  ),
);

register(
  'section-179-expensing@1.0.0',
  oneShot(
    '\u00a7179 expensing',
    entityDeduction({
      param: 'electedAmount',
      target: 'any',
      label: '§179 expensing election',
      missingNote: 'No business placing assets in service — not applied.',
    }),
  ),
);

// str-loophole: a short-term rental with material participation is
// non-passive without REPS — its result moves out of the §469 bucket.
register('str-loophole@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  if (profile.rentals.length === 0)
    return { profile, notes: ['No rental activity — not applied.'] };
  const targetId = typeof params.rentalId === 'string' ? params.rentalId : profile.rentals[0]!.id;
  const idx = profile.rentals.findIndex((r) => r.id === targetId);
  if (idx === -1) {
    // A stale rentalId must surface — never silently reclassify a
    // different property.
    return { profile, notes: [`STR treatment: rental "${targetId}" not found — not applied.`] };
  }
  const target = profile.rentals[idx]!;
  const rentals = profile.rentals.filter((_, i) => i !== idx);
  return {
    profile: { ...profile, rentals, otherIncome: profile.otherIncome + target.netIncome },
    notes: [
      `${target.name} treated as a non-passive short-term rental (average stay ≤ 7 days + material participation): ${usd(target.netIncome)} moves out of the §469 passive bucket. No SE tax absent substantial services.`,
    ],
  };
});

// reps-qualification: real estate professional status + material
// participation makes ALL rental results non-passive.
register('reps-qualification@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile } = ctx;
  if (profile.rentals.length === 0)
    return { profile, notes: ['No rental activities — not applied.'] };
  const total = profile.rentals.reduce((a, r) => a + r.netIncome, 0);
  return {
    profile: { ...profile, rentals: [], otherIncome: profile.otherIncome + total },
    notes: [
      `REPS + material participation: ${usd(total)} of rental results treated as non-passive (750-hour and more-than-half tests must hold).`,
    ],
  };
});

// ═══════════════════ Retirement (band 50–59) ═══════════════════

register(
  'cash-balance-stack@1.0.0',
  retirementContribution({
    label: 'Cash balance + 401(k) stack',
    compute: (ctx) => {
      const { seProfit, ownerWages } = retirementCompBase(ctx);
      const compBase = seProfit > 0 ? seProfit : ownerWages;
      const amount = Math.min(Math.max(num(ctx.params.totalContribution), 0), compBase);
      return {
        amount,
        notes:
          amount > 0
            ? [
                'Actuarially determined cash-balance credit plus 401(k) — plan document and TPA required.',
              ]
            : [],
      };
    },
  }),
);

register(
  'defined-benefit-plan@1.0.0',
  retirementContribution({
    label: 'Defined benefit plan',
    compute: (ctx) => {
      const { seProfit, ownerWages } = retirementCompBase(ctx);
      const compBase = seProfit > 0 ? seProfit : ownerWages;
      const amount = Math.min(Math.max(num(ctx.params.annualContribution), 0), compBase);
      return {
        amount,
        notes:
          amount > 0 ? ['Contribution is actuarially determined each year, not elective.'] : [],
      };
    },
  }),
);

register(
  'profit-sharing-new-comparability@1.0.0',
  retirementContribution({
    label: 'New-comparability profit sharing',
    compute: (ctx) => {
      const { seProfit, ownerWages } = retirementCompBase(ctx);
      const t = ctx.tableSet.retirement;
      const cap =
        seProfit > 0
          ? Math.round(Math.min(seProfit, t.compCap) * 0.2)
          : Math.round(Math.min(ownerWages, t.compCap) * 0.25);
      const amount = Math.min(Math.max(num(ctx.params.ownerAllocation), 0), cap, t.limit415c);
      return {
        amount,
        notes:
          amount > 0
            ? [
                'Cross-tested allocation must pass §401(a)(4) nondiscrimination testing with staff minimums funded.',
              ]
            : [],
      };
    },
  }),
);

register(
  'simple-ira@1.0.0',
  retirementContribution({
    label: 'SIMPLE IRA',
    compute: (ctx) => {
      const { seProfit, ownerWages } = retirementCompBase(ctx);
      const compBase = seProfit > 0 ? seProfit : ownerWages;
      if (compBase <= 0) return { amount: 0 };
      const t = ctx.tableSet.retirement;
      const deferral = Math.min(Math.max(num(ctx.params.deferral), 0), t.simpleLimit, compBase);
      const match = Math.min(Math.round(compBase * 0.03), deferral);
      return {
        amount: deferral + match,
        notes: [`Employee deferral ${usd(deferral)} plus 3% match ${usd(match)}.`],
      };
    },
  }),
);

// ═══════════════════ Income timing & character (band 60–69) ═══════════════════

// bracket-management: positive = defer income out of this year;
// negative = accelerate income INTO this year (Roth-style bracket fill —
// intentionally raises the current-year burden).
register('bracket-management@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const requested = num(params.deferAmount);
  const amount = requested >= 0 ? Math.min(requested, Math.max(profile.otherIncome, 0)) : requested;
  if (amount === 0) return { profile, notes: ['No income timing move configured.'] };
  return {
    profile: { ...profile, otherIncome: profile.otherIncome - amount },
    notes: [
      amount > 0
        ? `${usd(amount)} of income deferred into next year (invoice/bonus timing).`
        : `${usd(-amount)} of income accelerated into this year to fill the current bracket.`,
    ],
  };
});

// gain-loss-harvesting: realize available losses against recognized gains.
register('gain-loss-harvesting@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const st = Math.max(num(params.shortTermLossHarvested), 0);
  const lt = Math.max(num(params.longTermLossHarvested), 0);
  if (st + lt <= 0) return { profile, notes: ['No losses identified to harvest.'] };
  return {
    profile: {
      ...profile,
      shortTermCapGain: profile.shortTermCapGain - st,
      longTermCapGain: profile.longTermCapGain - lt,
    },
    notes: [
      `Harvested ${usd(st)} short-term and ${usd(lt)} long-term losses — netting, the $3,000 ordinary limit, and carryforward run through the engine. Wash-sale windows must be respected.`,
    ],
  };
});

register(
  'installment-sale-business@1.0.0',
  installmentSpread({
    gainParam: 'totalGain',
    yearsParam: 'termYears',
    label: 'Installment sale (business)',
  }),
);

// nol-planning: apply a carried NOL against ~80% of current income
// (§172(a)(2) limitation, approximated pre-deduction).
register('nol-planning@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params, carry, yearIndex } = ctx;
  // The carryforward is FINITE: year one starts from the parameter, later
  // projection years draw down whatever the prior year left. Without the
  // carry thread the full NOL would re-deduct every projection year.
  const opening =
    yearIndex === 0 ? Math.max(num(params.nolCarryforward), 0) : Math.max(num(carry.remaining), 0);
  if (opening <= 0) {
    return {
      profile,
      notes: [
        yearIndex === 0
          ? 'No NOL carryforward on file.'
          : 'NOL fully absorbed — nothing left to deduct.',
      ],
      carryPatch: { remaining: 0 },
    };
  }
  const incomeEstimate =
    Math.max(profile.wages, 0) +
    profile.businesses.reduce(
      (a, b) => a + Math.max(b.kind === 's-corp' ? b.netProfit - b.ownerWages : b.netProfit, 0),
      0,
    ) +
    Math.max(profile.interestIncome, 0) +
    Math.max(profile.ordinaryDividends + profile.qualifiedDividends, 0) +
    Math.max(profile.shortTermCapGain + profile.longTermCapGain, 0) +
    Math.max(profile.otherIncome, 0);
  const allowed = Math.min(opening, Math.round(incomeEstimate * 0.8));
  if (allowed <= 0) {
    return {
      profile,
      notes: ['No income for the NOL to offset this year.'],
      carryPatch: { remaining: opening },
    };
  }
  return {
    profile: { ...profile, adjustments: profile.adjustments + allowed },
    notes: [
      `${usd(allowed)} of NOL absorbed (80%-of-taxable-income limit approximated); ${usd(opening - allowed)} carries forward.`,
    ],
    carryPatch: { remaining: opening - allowed },
  };
});

register(
  'qsbs-1202@1.0.0',
  capitalGainReduction({
    param: 'eligibleGain',
    label: '§1202 QSBS exclusion',
    term: 'long',
    cap: () => 15_000_000,
  }),
);

// sstb-threshold-management: deliberate income compression (retirement,
// charitable, timing) to bring taxable income under the §199A phase-out.
register(
  'sstb-threshold-management@1.0.0',
  aboveTheLine({
    param: 'incomeReduction',
    label: 'SSTB threshold compression',
  }),
);

// ═══════════════════ Credits (band 70–79) ═══════════════════

register(
  'childcare-credit-45f@1.0.0',
  credit({
    label: '§45F employer childcare credit',
    compute: (params) => {
      const spend = Math.max(num(params.qualifiedExpenditures), 0);
      const small = params.smallBusiness === true;
      const rate = small ? 0.5 : 0.4;
      const cap = small ? 600_000 : 500_000;
      return Math.min(spend * rate, cap);
    },
  }),
);

register(
  'disabled-access-credit@1.0.0',
  oneShot(
    '\u00a744 disabled access credit',
    credit({
      label: '§44 disabled access credit',
      compute: (params) => {
        const spend = Math.max(num(params.accessExpenditures), 0);
        return Math.min(Math.max(spend - 250, 0), 10_000) * 0.5;
      },
    }),
  ),
);

register(
  'energy-credits@1.0.0',
  oneShot(
    'Business energy credits',
    credit({
      label: 'Business energy credits',
      compute: (params) => Math.max(num(params.creditAmount), 0),
      note: (amount) =>
        `${usd(amount)} of business energy credits (ITC/EV charging) — basis reduction and recapture reviewed outside the model.`,
    }),
  ),
);

register(
  'pfml-credit-45s@1.0.0',
  credit({
    label: '§45S paid family leave credit',
    compute: (params) => {
      const wages = Math.max(num(params.leaveWagesPaid), 0);
      const payPct = Math.min(Math.max(num(params.paymentRatePct, 50), 50), 100);
      const rate = Math.min(0.125 + 0.0025 * (payPct - 50), 0.25);
      return wages * rate;
    },
  }),
);

register(
  'rd-credit@1.0.0',
  credit({
    label: '§41 R&D credit (ASC)',
    compute: (params) => {
      const qre = Math.max(num(params.qre), 0);
      const priorAvg = Math.max(num(params.priorThreeYearAvgQre), 0);
      const base = priorAvg > 0 ? Math.max(qre - 0.5 * priorAvg, 0) * 0.14 : qre * 0.06;
      return base;
    },
    note: (amount) =>
      `${usd(amount)} §41 credit under the alternative simplified method — §280C(c) deduction interplay handled at return time.`,
  }),
);

register(
  'wotc@1.0.0',
  credit({
    label: 'Work opportunity credit',
    compute: (params) => Math.max(num(params.qualifiedFirstYearWages), 0) * 0.4,
    note: (amount) =>
      `${usd(amount)} WOTC (40% of certified first-year wages) — Form 8850 pre-screening deadlines are strict.`,
  }),
);
