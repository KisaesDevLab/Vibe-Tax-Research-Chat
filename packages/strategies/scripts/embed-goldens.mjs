// TP-6 — computes golden expected deltas through the real engine and
// embeds them into the content records. Run AFTER building engine +
// strategies. The printed table is the human sanity check: signs and
// magnitudes must make tax sense before the values are committed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeScenario } from '../../engine/dist/index.js';
import { resolveApply } from '../dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tables = JSON.parse(
  readFileSync(path.resolve(root, '../db/seeds/table-sets/2026.json'), 'utf-8'),
).payload;

const base = (over = {}) => ({
  filingStatus: 'single',
  state: null,
  wages: 0,
  businesses: [],
  rentals: [],
  interestIncome: 0,
  ordinaryDividends: 0,
  qualifiedDividends: 0,
  shortTermCapGain: 0,
  longTermCapGain: 0,
  otherIncome: 0,
  adjustments: 0,
  seHealthInsurance: 0,
  retirementContributions: 0,
  hsaContribution: 0,
  itemized: { stateLocalTaxesPaid: 0, mortgageInterest: 0, charitable: 0, other: 0 },
  dependentsUnder17: 0,
  otherDependents: 0,
  withholding: 0,
  estimatedPayments: 0,
  qbiReduction: 0,
  otherCredits: 0,
  corpTaxPaid: 0,
  otherTaxes: 0,
  ptetPaid: 0,
  ...over,
});

const schC = (netProfit, over = {}) => ({
  id: 'b1',
  name: 'Business',
  kind: 'schedule-c',
  netProfit,
  employeeWages: 0,
  ownerWages: 0,
  sstb: false,
  qbiEligible: true,
  ...over,
});
const sCorp = (netProfit, ownerWages, over = {}) => ({
  id: 's1',
  name: 'S corp',
  kind: 's-corp',
  netProfit,
  employeeWages: 0,
  ownerWages,
  sstb: false,
  qbiEligible: true,
  ...over,
});

// Golden case definitions: strategy → [{name, profile, params}]
const CASES = {
  's-corp-election': [
    {
      name: 'single Sch C 150k, comp 60k',
      profile: base({ businesses: [schC(150_000)] }),
      params: { ownerWages: 60_000 },
    },
    {
      name: 'mfj Sch C 300k, comp 120k',
      profile: base({ filingStatus: 'mfj', businesses: [schC(300_000)] }),
      params: { ownerWages: 120_000 },
    },
  ],
  'hire-children': [
    {
      name: 'mfj Sch C 150k, 2 kids at 8k',
      profile: base({
        filingStatus: 'mfj',
        dependentsUnder17: 2,
        businesses: [schC(150_000)],
      }),
      params: { children: 2, annualWagesEach: 8_000 },
    },
    {
      name: 'mfj Sch C 200k, 1 kid at the standard deduction',
      profile: base({
        filingStatus: 'mfj',
        dependentsUnder17: 1,
        businesses: [schC(200_000)],
      }),
      params: { children: 1, annualWagesEach: 16_100 },
    },
  ],
  'augusta-rule': [
    {
      name: 'mfj S-corp 200k/80k comp, 14 days at $800',
      profile: base({ filingStatus: 'mfj', businesses: [sCorp(200_000, 80_000)] }),
      params: { days: 14, dailyRate: 800 },
    },
    {
      name: 'mfj S-corp 200k/80k comp, 10 days at $500',
      profile: base({ filingStatus: 'mfj', businesses: [sCorp(200_000, 80_000)] }),
      params: { days: 10, dailyRate: 500 },
    },
  ],
  'accountable-plan': [
    {
      name: 'mfj S-corp 200k/80k comp, 12k reimbursed',
      profile: base({ filingStatus: 'mfj', businesses: [sCorp(200_000, 80_000)] }),
      params: { annualReimbursement: 12_000 },
    },
    {
      name: 'single S-corp 120k/50k comp, 5k reimbursed',
      profile: base({ businesses: [sCorp(120_000, 50_000)] }),
      params: { annualReimbursement: 5_000 },
    },
  ],
  'se-health-insurance': [
    {
      name: 'single Sch C 100k, 12k premium',
      profile: base({ businesses: [schC(100_000)] }),
      params: { annualPremium: 12_000 },
    },
    {
      name: 'mfj Sch C 60k, 30k premium (no clip)',
      profile: base({ filingStatus: 'mfj', businesses: [schC(60_000)] }),
      params: { annualPremium: 30_000 },
    },
  ],
  'hsa-contributions': [
    {
      name: 'single Sch C 100k, family coverage',
      profile: base({ businesses: [schC(100_000)] }),
      params: { coverage: 'family' },
    },
    {
      name: 'mfj wages 150k, self + catch-up',
      profile: base({ filingStatus: 'mfj', wages: 150_000 }),
      params: { coverage: 'self', catchUp55: true },
    },
  ],
  'solo-401k': [
    {
      name: 'single Sch C 150k, max deferral + 20k employer',
      profile: base({ businesses: [schC(150_000)] }),
      params: { employeeDeferral: 24_500, employerContribution: 20_000 },
    },
    {
      name: 'mfj Sch C 90k, 10k deferral only',
      profile: base({ filingStatus: 'mfj', businesses: [schC(90_000)] }),
      params: { employeeDeferral: 10_000 },
    },
  ],
  'sep-ira': [
    {
      name: 'single Sch C 200k, 40k SEP (at the 20% cap)',
      profile: base({ businesses: [schC(200_000)] }),
      params: { contribution: 40_000 },
    },
    {
      name: 'mfj Sch C 100k, oversized request clips to 20k',
      profile: base({ filingStatus: 'mfj', businesses: [schC(100_000)] }),
      params: { contribution: 100_000 },
    },
  ],
  ptet: [
    {
      name: 'mfj S-corp 300k/100k comp, 5% flat state, itemizer',
      profile: base({
        filingStatus: 'mfj',
        state: { code: 'XX', flatRate: 0.05 },
        businesses: [sCorp(300_000, 100_000)],
        itemized: { stateLocalTaxesPaid: 20_000, mortgageInterest: 25_000, charitable: 0, other: 0 },
      }),
      params: {},
    },
    {
      name: 'mfj S-corp 300k/100k comp, MO 4.7%, standard deduction',
      profile: base({
        filingStatus: 'mfj',
        state: { code: 'MO', flatRate: 0.047 },
        businesses: [sCorp(300_000, 100_000)],
      }),
      params: {},
    },
  ],
};

const contentDir = path.join(root, 'content');
for (const [id, cases] of Object.entries(CASES)) {
  const file = path.join(contentDir, `${id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf-8'));
  if (!record.model) throw new Error(`${id} is not modeled`);
  const apply = resolveApply(record.model.apply.module);
  const goldens = [];
  for (const c of cases) {
    const run = (transforms) =>
      composeScenario({
        baseline: c.profile,
        transforms,
        years: 1,
        growthPct: 0,
        tableSet: tables,
        startYear: 2026,
      });
    const baseRun = run([]);
    const withRun = run([
      { strategyId: id, applyOrder: record.model.applyOrder, params: c.params, apply },
    ]);
    const delta = withRun.years[0].totalBurden - baseRun.years[0].totalBurden;
    console.log(
      `${id.padEnd(20)} ${c.name.padEnd(52)} baseline=${baseRun.years[0].totalBurden
        .toString()
        .padStart(8)}  delta=${delta.toString().padStart(8)}`,
    );
    goldens.push({
      name: c.name,
      profile: c.profile,
      params: c.params,
      expect: { totalBurdenDelta: delta, tolerance: 1 },
    });
  }
  record.model.goldenTests = goldens;
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
}
console.log('\nGoldens embedded.');
