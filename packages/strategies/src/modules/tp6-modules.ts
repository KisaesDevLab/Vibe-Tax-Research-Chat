// TP-6 — apply modules for the walking-skeleton strategies. Every
// function is a pure profile transform: it declares WHAT changes (wages
// shift, a deduction appears, a contribution lands above the line); the
// engine computes the tax. Params are validated against each record's
// inputs schema at the API boundary; modules still clamp defensively.
import type { BusinessProfile } from '@vibe/shared';
import type { ApplyContext, ApplyResult } from '../types.js';
import { register } from './index.js';

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function findTarget(businesses: BusinessProfile[], kind: BusinessProfile['kind']): number {
  return businesses.findIndex((b) => b.kind === kind);
}

// ── s-corp-election@1.0.0 (band 10) ──────────────────────────────────────
// Converts the largest Schedule C to an S corporation with reasonable
// W-2 comp. SE tax disappears; owner payroll tax appears; QBI wage base
// gains the owner wages.
register('s-corp-election@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const idx = findTarget(profile.businesses, 'schedule-c');
  if (idx === -1) {
    return { profile, notes: ['No Schedule C business to convert — election not applied.'] };
  }
  const target = profile.businesses[idx]!;
  const wages = Math.min(Math.max(num(params.ownerWages), 0), Math.max(target.netProfit, 0));
  const businesses = profile.businesses.map((b, i) =>
    i === idx ? { ...b, kind: 's-corp' as const, ownerWages: wages } : b,
  );
  return {
    profile: { ...profile, businesses },
    notes: [
      `S election on ${target.name}: reasonable comp set at $${wages.toLocaleString('en-US')}.`,
    ],
  };
});

// ── hire-children@1.0.0 (band 20) ────────────────────────────────────────
// Wages for bona fide work are an entity deduction; under-18 children of
// a sole proprietor are FICA-exempt and the wages land inside the
// child's own standard deduction (the child's return is out of scope for
// this profile).
register('hire-children@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params, tableSet } = ctx;
  if (profile.businesses.length === 0) {
    return { profile, notes: ['No business to employ the children — not applied.'] };
  }
  const children = Math.max(1, Math.floor(num(params.children, 1)));
  const perChild = Math.min(
    Math.max(num(params.annualWagesEach), 0),
    tableSet.standardDeduction.single,
  );
  const total = children * perChild;
  const idx = 0; // largest/first business pays
  const target = profile.businesses[idx]!;
  const businesses = profile.businesses.map((b, i) =>
    i === idx
      ? { ...b, netProfit: b.netProfit - total, employeeWages: b.employeeWages + total }
      : b,
  );
  const notes = [
    `${children} child${children === 1 ? '' : 'ren'} on payroll at $${perChild.toLocaleString(
      'en-US',
    )} each — $${total.toLocaleString('en-US')} deducted.`,
  ];
  if (target.kind !== 'schedule-c') {
    notes.push(
      'Payor is not a parent-owned sole proprietorship — FICA exemption for under-18 children does not apply; model wages as employee cost only.',
    );
  }
  return { profile: { ...profile, businesses }, notes };
});

// ── augusta-rule@1.0.0 (band 30) ─────────────────────────────────────────
// ≤14 days of fair-market rent: entity deducts, owner excludes (§280A(g)).
register('augusta-rule@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const entityIdx = profile.businesses.findIndex(
    (b) => b.kind === 's-corp' || b.kind === 'partnership',
  );
  if (entityIdx === -1) {
    return {
      profile,
      notes: ['No separate payor entity — §280A(a) leaves the self-payor with no deduction.'],
    };
  }
  const days = Math.min(Math.max(Math.floor(num(params.days, 12)), 1), 14);
  const rent = days * Math.max(num(params.dailyRate), 0);
  const businesses = profile.businesses.map((b, i) =>
    i === entityIdx ? { ...b, netProfit: b.netProfit - rent } : b,
  );
  return {
    profile: { ...profile, businesses },
    notes: [
      `${days} documented rental day(s) at fair-market rate — $${rent.toLocaleString(
        'en-US',
      )} deducted by the entity, excluded from the owner's income.`,
    ],
  };
});

// ── accountable-plan@1.0.0 (band 30) ─────────────────────────────────────
register('accountable-plan@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const entityIdx = profile.businesses.findIndex(
    (b) => b.kind === 's-corp' || b.kind === 'partnership',
  );
  if (entityIdx === -1) {
    return {
      profile,
      notes: [
        'Accountable plans matter for entity owners; a sole proprietor already deducts directly.',
      ],
    };
  }
  const amount = Math.max(num(params.annualReimbursement), 0);
  const businesses = profile.businesses.map((b, i) =>
    i === entityIdx ? { ...b, netProfit: b.netProfit - amount } : b,
  );
  return {
    profile: { ...profile, businesses },
    notes: [
      `$${amount.toLocaleString('en-US')} of substantiated reimbursements moved onto the entity.`,
    ],
  };
});

// ── se-health-insurance@1.0.0 (band 30) ──────────────────────────────────
register('se-health-insurance@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params } = ctx;
  const premium = Math.max(num(params.annualPremium), 0);
  const seEarnings = profile.businesses.reduce((a, b) => a + Math.max(b.netProfit, 0), 0);
  const allowed = Math.min(premium, seEarnings);
  const notes = [
    `$${allowed.toLocaleString('en-US')} of health premiums moved above the line (§162(l)).`,
  ];
  if (allowed < premium) {
    notes.push('§162(l) earned-income limit clipped the deduction to business earnings.');
  }
  return {
    profile: { ...profile, seHealthInsurance: profile.seHealthInsurance + allowed },
    notes,
  };
});

// ── hsa-contributions@1.0.0 (band 30) ────────────────────────────────────
register('hsa-contributions@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params, tableSet } = ctx;
  const coverage = params.coverage === 'family' ? 'family' : 'self';
  const base = coverage === 'family' ? tableSet.retirement.hsaFamily : tableSet.retirement.hsaSelf;
  const catchUp = params.catchUp55 === true ? tableSet.retirement.hsaCatchUp : 0;
  const amount = base + catchUp;
  return {
    profile: { ...profile, hsaContribution: profile.hsaContribution + amount },
    notes: [
      `HSA funded to the ${coverage} limit${catchUp ? ' plus catch-up' : ''}: $${amount.toLocaleString('en-US')}.`,
    ],
  };
});

// ── solo-401k@1.0.0 (band 50) ────────────────────────────────────────────
register('solo-401k@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params, tableSet } = ctx;
  const seProfit = profile.businesses
    .filter((b) => b.kind === 'schedule-c' || b.kind === 'partnership')
    .reduce((a, b) => a + Math.max(b.netProfit, 0), 0);
  const ownerWages = profile.businesses.reduce((a, b) => a + Math.max(b.ownerWages, 0), 0);
  const compBase = seProfit > 0 ? seProfit : ownerWages;
  if (compBase <= 0) {
    return { profile, notes: ['No earned income to support a solo 401(k) — not applied.'] };
  }
  const deferral = Math.min(
    Math.max(num(params.employeeDeferral), 0),
    tableSet.retirement.limit402g,
  );
  // Employer side: 25% of W-2 comp, or ~20% of net SE income (the
  // self-employed circular calculation).
  const employerCap = seProfit > 0 ? Math.round(seProfit * 0.2) : Math.round(ownerWages * 0.25);
  const employer = Math.min(Math.max(num(params.employerContribution), 0), employerCap);
  const total = Math.min(deferral + employer, tableSet.retirement.limit415c, compBase);
  return {
    profile: { ...profile, retirementContributions: profile.retirementContributions + total },
    notes: [
      `Solo 401(k): $${total.toLocaleString('en-US')} (deferral + employer), within the §415(c) limit.`,
    ],
  };
});

// ── sep-ira@1.0.0 (band 50) ──────────────────────────────────────────────
register('sep-ira@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile, params, tableSet } = ctx;
  const seProfit = profile.businesses
    .filter((b) => b.kind === 'schedule-c' || b.kind === 'partnership')
    .reduce((a, b) => a + Math.max(b.netProfit, 0), 0);
  const ownerWages = profile.businesses.reduce((a, b) => a + Math.max(b.ownerWages, 0), 0);
  const cap =
    seProfit > 0
      ? Math.round(Math.min(seProfit, tableSet.retirement.compCap) * 0.2)
      : Math.round(Math.min(ownerWages, tableSet.retirement.compCap) * 0.25);
  const amount = Math.min(
    Math.max(num(params.contribution), 0),
    cap,
    tableSet.retirement.limit415c,
  );
  if (amount <= 0) {
    return { profile, notes: ['No SEP capacity on this income — not applied.'] };
  }
  return {
    profile: { ...profile, retirementContributions: profile.retirementContributions + amount },
    notes: [`SEP-IRA employer contribution of $${amount.toLocaleString('en-US')}.`],
  };
});

// ── ptet@1.0.0 (band 80) ─────────────────────────────────────────────────
// Entity-level election: the entity pays state tax on pass-through
// income (deduction, escaping the SALT cap); the owner claims a credit.
// The owner's personally-paid SALT drops accordingly.
register('ptet@1.0.0', (ctx: ApplyContext): ApplyResult => {
  const { profile } = ctx;
  if (!profile.state || profile.state.flatRate <= 0) {
    return { profile, notes: ['No flat-state model configured — PTET not applied.'] };
  }
  const passThroughIncome = profile.businesses
    .filter((b) => b.kind === 's-corp' || b.kind === 'partnership')
    .reduce(
      (a, b) => a + Math.max(b.kind === 's-corp' ? b.netProfit - b.ownerWages : b.netProfit, 0),
      0,
    );
  if (passThroughIncome <= 0) {
    return { profile, notes: ['No pass-through entity income — PTET not applied.'] };
  }
  const entityTax = Math.round(passThroughIncome * profile.state.flatRate);
  const saltRelief = Math.min(profile.itemized.stateLocalTaxesPaid, entityTax);
  return {
    profile: {
      ...profile,
      ptetPaid: profile.ptetPaid + entityTax,
      itemized: {
        ...profile.itemized,
        stateLocalTaxesPaid: profile.itemized.stateLocalTaxesPaid - saltRelief,
      },
    },
    notes: [
      `PTET election: entity pays $${entityTax.toLocaleString('en-US')} of state tax (federal deduction above the SALT cap); owner claims the credit.`,
    ],
  };
});
