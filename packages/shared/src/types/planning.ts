// TP-4/TP-5/TP-6 — planning wire types: the client baseline profile the
// engine consumes, the per-year result it produces, and the carryforward
// state threaded between projection years. Dollar amounts are whole
// dollars on the wire; the engine converts to cents internally.
import type { FilingStatus } from './table-set.js';

export interface BusinessProfile {
  id: string;
  name: string;
  kind: 'schedule-c' | 's-corp' | 'partnership';
  /** Net profit BEFORE owner wages (S-corp: pre-wage profit). */
  netProfit: number;
  /** W-2 wages the business pays to non-owner employees. */
  employeeWages: number;
  /** W-2 wages paid to the owner (S-corp reasonable comp). */
  ownerWages: number;
  sstb: boolean;
  qbiEligible: boolean;
}

export interface RentalProfile {
  id: string;
  name: string;
  netIncome: number; // negative = loss
  activeParticipant: boolean;
}

export interface BaselineProfile {
  filingStatus: FilingStatus;
  /** Flat-rate state; null/undefined = no state income tax modeled. */
  state?: { code: string; flatRate: number } | null;
  wages: number; // taxpayer + spouse W-2 wages outside the modeled businesses
  businesses: BusinessProfile[];
  rentals: RentalProfile[];
  interestIncome: number;
  ordinaryDividends: number; // non-qualified portion
  qualifiedDividends: number;
  shortTermCapGain: number;
  longTermCapGain: number;
  otherIncome: number;
  /** Above-the-line adjustments hook (strategy transforms add here). */
  adjustments: number;
  seHealthInsurance: number;
  /** Above-the-line retirement (traditional solo-401k/SEP employee+employer). */
  retirementContributions: number;
  hsaContribution: number;
  itemized: {
    stateLocalTaxesPaid: number;
    mortgageInterest: number;
    charitable: number;
    other: number;
  };
  dependentsUnder17: number;
  otherDependents: number;
  withholding: number;
  estimatedPayments: number;
  // ── strategy transform hooks (see docs/strategy-schema.md) ──
  qbiReduction: number; // reduces aggregate QBI (e.g., reasonable-comp shifts)
  otherCredits: number;
  corpTaxPaid: number; // C-corp entity tax the plan should surface
  otherTaxes: number;
  ptetPaid: number; // entity-level PTET: deduction + state credit
}

export interface CarryforwardState {
  /** §469 suspended passive losses by rental/activity id (positive = suspended). */
  passiveByActivity: Record<string, number>;
  capitalLossCarryforward: number;
}

export const EMPTY_CARRYFORWARD: CarryforwardState = {
  passiveByActivity: {},
  capitalLossCarryforward: 0,
};

/** One computed year. Whole dollars. */
export interface YearResult {
  year: number;
  // income build-up
  seTax: number;
  seTaxDeduction: number;
  ownerPayrollTax: number; // both halves of FICA on owner W-2 wages
  additionalMedicare: number;
  passiveAllowedLoss: number;
  passiveSuspended: number; // total suspended going forward
  totalIncome: number;
  agi: number;
  magi: number;
  // deductions
  itemizedTotal: number;
  saltDeducted: number;
  standardDeduction: number;
  usedItemized: boolean;
  qbiDeduction: number;
  taxableIncome: number;
  // tax
  ordinaryTax: number;
  capitalGainsTax: number;
  incomeTaxBeforeCredits: number;
  ctc: number;
  otherCredits: number;
  incomeTax: number; // after credits, not below 0
  niit: number;
  stateTax: number; // after PTET credit
  ptetCredit: number;
  corpTaxPaid: number;
  otherTaxes: number;
  totalBurden: number;
  // payments
  payments: number;
  balanceDue: number;
  notes: string[];
}

// ── Plan wire types (TP-6+) ──
export type PlanStatus = 'draft' | 'in-review' | 'presented' | 'engaged' | 'delivered' | 'archived';

export interface StrategySelection {
  strategyId: string;
  version: string;
  params: Record<string, unknown>;
}

export interface PlanDTO {
  id: string;
  client_id: string;
  status: PlanStatus;
  title: string;
  baseline_profile: BaselineProfile;
  growth_pct: number;
  years: number;
  table_set_id: string;
  engine_version: string;
  fee_plan: { flatFee?: number; note?: string } | null;
  assigned_to: string | null;
  reviewer_id: string | null;
  review_state: Record<string, boolean>;
  created_at: string;
  updated_at: string;
}

export interface PlanScenarioDTO {
  id: string;
  plan_id: string;
  label: string;
  selections: StrategySelection[];
}

export interface PlanResultDTO {
  id: string;
  plan_id: string;
  scenario_id: string | null; // null = baseline
  year: number;
  result: YearResult;
  table_set_id: string;
  engine_version: string;
  strategy_versions: Record<string, string>;
  computed_at: string;
}

// TP-5a — tri-state suggestion wire types (POST /api/planning/strategies/suggest).
export interface StrategySuggestionDTO {
  strategyId: string;
  status: 'matched' | 'toConfirm' | 'excluded';
  /** Rendered for matched AND toConfirm; '' when excluded. */
  reason: string;
  matched: string[];
  toConfirm: string[];
  excluded: string[];
}

export interface SuggestResponse {
  suggestions: StrategySuggestionDTO[];
  has_fact_snapshot: boolean;
}
