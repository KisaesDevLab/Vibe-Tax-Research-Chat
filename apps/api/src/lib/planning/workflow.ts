// TP-8 — plan lifecycle graph + review-gate evaluation, kept pure so the
// transition rules are unit-testable without a database.
import type { PlanStatus, StrategySelection } from '@vibe/shared';

export const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ['in-review'],
  'in-review': ['draft', 'presented'],
  // presented → draft reopens the plan for changes. Presenting freezes
  // results (app-side and via the migration-0012 trigger), so without a
  // back-edge a typo after presenting meant rebuilding the plan from
  // scratch. Reopening thaws it and clears any review ticks so a stale
  // sign-off cannot pre-satisfy the gate on the way back out.
  presented: ['engaged', 'archived', 'draft'],
  engaged: ['delivered', 'archived'],
  delivered: ['archived'],
  archived: [],
};

/** Transitions that reopen a frozen plan for editing. */
export function isReopen(from: PlanStatus, to: PlanStatus): boolean {
  return from === 'presented' && to === 'draft';
}

/**
 * Transitions available from `from`. Partner review is opt-in
 * (SETTING_KEYS.PLAN_REVIEW_REQUIRED): with it off, draft short-circuits
 * straight to presented. The in-review path stays reachable either way so
 * a firm that wants the four-eyes discipline loses nothing by the default.
 */
export function allowedTransitions(from: PlanStatus, reviewRequired: boolean): PlanStatus[] {
  const base = TRANSITIONS[from] ?? [];
  if (!reviewRequired && from === 'draft') return [...base, 'presented'];
  return base;
}

export function canTransition(from: PlanStatus, to: PlanStatus, reviewRequired = true): boolean {
  return allowedTransitions(from, reviewRequired).includes(to);
}

export interface ReviewGateInput {
  selections: StrategySelection[];
  /** strategyId → its published content record (advisor.reviewChecklist, riskRating). */
  records: Map<string, { riskRating: string; reviewChecklist: string[] }>;
  /** Checklist ticks: `${strategyId}:${index}` → true. */
  reviewState: Record<string, boolean>;
  /** strategyIds that have ≥1 active linked research archive. */
  linkedStrategies: Set<string>;
  reviewerId: string | null;
  preparerId: string | null;
}

export interface ReviewGateResult {
  ok: boolean;
  failures: Array<{ code: string; strategyId?: string; message: string }>;
}

/** Guards for in-review → presented. */
export function evaluateReviewGate(input: ReviewGateInput): ReviewGateResult {
  const failures: ReviewGateResult['failures'] = [];

  if (!input.reviewerId) {
    failures.push({ code: 'no_reviewer', message: 'A reviewing partner must be assigned.' });
  } else if (input.preparerId && input.reviewerId === input.preparerId) {
    failures.push({
      code: 'reviewer_is_preparer',
      message: 'The reviewer must be different from the preparer.',
    });
  }

  for (const sel of input.selections) {
    const record = input.records.get(sel.strategyId);
    if (!record) {
      failures.push({
        code: 'unknown_strategy',
        strategyId: sel.strategyId,
        message: `No published record for ${sel.strategyId}.`,
      });
      continue;
    }
    for (let i = 0; i < record.reviewChecklist.length; i++) {
      if (!input.reviewState[`${sel.strategyId}:${i}`]) {
        failures.push({
          code: 'checklist_incomplete',
          strategyId: sel.strategyId,
          message: `Unchecked: ${record.reviewChecklist[i]}`,
        });
      }
    }
    // The elevated-risk HARD gate (master-plan FINAL decision 4).
    if (record.riskRating === 'elevated' && !input.linkedStrategies.has(sel.strategyId)) {
      failures.push({
        code: 'elevated_risk_unlinked',
        strategyId: sel.strategyId,
        message: `${sel.strategyId} is elevated-risk and requires a linked archived research session.`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}
