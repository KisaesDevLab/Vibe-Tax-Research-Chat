// TP-5 — apply-module contract. A strategy transform is a pure function:
// profile in, transformed profile out (plus notes and an optional carry
// patch). It NEVER computes tax — the engine does — and it never mutates
// its input.
import type { BaselineProfile, TableSetPayload } from '@vibe/shared';

export interface ApplyContext {
  profile: BaselineProfile;
  params: Record<string, unknown>;
  tableSet: TableSetPayload;
  /** Calendar year being computed. */
  year: number;
  /** 0-based index within the projection window. */
  yearIndex: number;
  /** Read-only view of strategy-scoped carry state from prior years. */
  carry: Record<string, unknown>;
}

export interface ApplyResult {
  profile: BaselineProfile;
  notes?: string[];
  /** Merged into the strategy's carry state for subsequent years. */
  carryPatch?: Record<string, unknown>;
}

export type ApplyFn = (ctx: ApplyContext) => ApplyResult;

/** The full authored record shape (docs/strategy-schema.md v1.0). */
export interface StrategyRecord {
  id: string;
  version: string;
  status: string;
  effectiveTaxYears: { from: number; to: number | null };
  lastReviewed: string;
  reviewedBy: string | null;
  changeLog: Array<{ version: string; date: string; note: string }>;
  name: string;
  category: string;
  modeled: boolean;
  complexity: number;
  riskRating: 'low' | 'moderate' | 'elevated';
  entityTypes: string[];
  typicalSavingsBand: string;
  advisor: {
    summary: string;
    mechanics: string[];
    authority: Array<{ type: string; cite: string; note: string }>;
    requirements: string[];
    risks: string[];
    stateNotes: string[];
    interactions: { requires: string[]; conflictsWith: string[]; synergiesWith: string[] };
    reviewChecklist: string[];
  };
  client: {
    teaser: string;
    headline: string;
    plainEnglish: string[];
    analogy: string;
    benefits: string[];
    steps: string[];
    clientCommitments: string[];
  };
  engagement: {
    implementationEffort: string;
    annualMaintenance: string[];
    deliverables: string[];
    feeGuidanceBand: string | null;
  };
  model?: {
    applyOrder: number;
    inputs: Record<string, unknown>;
    apply: { module: string };
    suggest: Record<string, unknown> & { reason: string };
    goldenTests: Array<{
      name: string;
      profile: Record<string, unknown>;
      params: Record<string, unknown>;
      expect: { totalBurdenDelta: number; tolerance: number };
    }>;
  };
  /** Advisory strategies still carry a suggest rule (master plan: all 100). */
  suggest?: Record<string, unknown> & { reason: string };
  monitoring: {
    watchAuthorities: string[];
    keywords: string[];
    reviewTriggers: string[];
  };
}
