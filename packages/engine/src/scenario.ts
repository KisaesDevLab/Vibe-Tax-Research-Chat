// TP-5 — scenario composition. Applies strategy transforms to the
// baseline profile in applyOrder-band order (deterministic tiebreak on
// strategy id), projects income growth across the plan window, threads
// both engine carryforward state and per-strategy carry, and zeroes
// payments in projection years (only year 1 knows withholding).
//
// The engine does not depend on @vibe/strategies — callers hand it
// already-resolved transform functions matching ScenarioTransform.
import type { BaselineProfile, CarryforwardState, TableSetPayload, YearResult } from '@vibe/shared';
import { EMPTY_CARRYFORWARD } from '@vibe/shared';
import { computeYear } from './compute-year.js';

export interface ScenarioTransformContext {
  profile: BaselineProfile;
  params: Record<string, unknown>;
  tableSet: TableSetPayload;
  year: number;
  yearIndex: number;
  carry: Record<string, unknown>;
}

export interface ScenarioTransformResult {
  profile: BaselineProfile;
  notes?: string[];
  carryPatch?: Record<string, unknown>;
}

export interface ScenarioTransform {
  strategyId: string;
  applyOrder: number;
  params: Record<string, unknown>;
  apply: (ctx: ScenarioTransformContext) => ScenarioTransformResult;
}

export interface ComposeScenarioInput {
  baseline: BaselineProfile;
  transforms: ScenarioTransform[];
  years: number;
  growthPct: number; // e.g. 3 = 3%/yr on income fields
  tableSet: TableSetPayload;
  startYear: number;
}

export interface ComposeScenarioOutput {
  years: YearResult[];
  notes: string[];
}

function growProfile(p: BaselineProfile, factor: number): BaselineProfile {
  const g = (n: number) => Math.round(n * factor);
  return {
    ...p,
    wages: g(p.wages),
    businesses: p.businesses.map((b) => ({
      ...b,
      netProfit: g(b.netProfit),
      employeeWages: g(b.employeeWages),
      ownerWages: g(b.ownerWages),
    })),
    rentals: p.rentals.map((r) => ({ ...r, netIncome: g(r.netIncome) })),
    interestIncome: g(p.interestIncome),
    ordinaryDividends: g(p.ordinaryDividends),
    qualifiedDividends: g(p.qualifiedDividends),
    shortTermCapGain: g(p.shortTermCapGain),
    longTermCapGain: g(p.longTermCapGain),
    otherIncome: g(p.otherIncome),
  };
}

export function composeScenario(input: ComposeScenarioInput): ComposeScenarioOutput {
  const { baseline, transforms, years, growthPct, tableSet, startYear } = input;
  // Deterministic order: applyOrder, then strategy id. Input order must
  // never matter (locked by the property test).
  const ordered = [...transforms].sort((a, b) =>
    a.applyOrder !== b.applyOrder
      ? a.applyOrder - b.applyOrder
      : a.strategyId < b.strategyId
        ? -1
        : a.strategyId > b.strategyId
          ? 1
          : 0,
  );

  const results: YearResult[] = [];
  const allNotes: string[] = [];
  let engineCarry: CarryforwardState = EMPTY_CARRYFORWARD;
  const strategyCarry: Record<string, Record<string, unknown>> = {};

  for (let yearIndex = 0; yearIndex < years; yearIndex++) {
    const factor = Math.pow(1 + growthPct / 100, yearIndex);
    let profile = growProfile(baseline, factor);
    if (yearIndex > 0) {
      // Projection years know nothing about payments.
      profile = { ...profile, withholding: 0, estimatedPayments: 0 };
    }

    for (const t of ordered) {
      const out = t.apply({
        profile,
        params: t.params,
        tableSet,
        year: startYear + yearIndex,
        yearIndex,
        carry: strategyCarry[t.strategyId] ?? {},
      });
      profile = out.profile;
      if (out.notes && out.notes.length > 0) {
        for (const n of out.notes) allNotes.push(`[${t.strategyId} y${yearIndex + 1}] ${n}`);
      }
      if (out.carryPatch) {
        strategyCarry[t.strategyId] = { ...(strategyCarry[t.strategyId] ?? {}), ...out.carryPatch };
      }
    }

    const { result, carryOut } = computeYear(profile, tableSet, engineCarry, startYear + yearIndex);
    engineCarry = carryOut;
    results.push(result);
  }

  return { years: results, notes: allNotes };
}
