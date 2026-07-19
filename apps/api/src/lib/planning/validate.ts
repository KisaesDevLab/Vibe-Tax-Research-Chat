// QA round 1 — server-side validation for the two write paths that
// previously accepted arbitrary JSON:
//   1. baseline_profile (PATCH plan + intake confirm): a zod schema for
//      BaselineProfile so a stringly-typed profile can never reach the
//      engine and produce NaN results.
//   2. scenario selection params: checked against each strategy's
//      published inputs_schema (JSON Schema subset: type, minimum,
//      maximum, enum, required — the only constructs the authored
//      schemas use).
import { z } from 'zod';

const finite = z.number().finite();

const businessSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(['schedule-c', 's-corp', 'partnership']),
  netProfit: finite,
  employeeWages: finite.min(0),
  ownerWages: finite.min(0),
  sstb: z.boolean(),
  qbiEligible: z.boolean(),
});

const rentalSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  netIncome: finite,
  activeParticipant: z.boolean(),
});

export const baselineProfileSchema = z.object({
  filingStatus: z.enum(['single', 'mfj', 'mfs', 'hoh']),
  state: z
    .object({ code: z.string().min(1).max(8), flatRate: finite.min(0).max(0.2) })
    .nullable()
    .optional(),
  wages: finite.min(0),
  businesses: z.array(businessSchema).max(20),
  rentals: z.array(rentalSchema).max(50),
  interestIncome: finite,
  ordinaryDividends: finite,
  qualifiedDividends: finite.min(0),
  shortTermCapGain: finite,
  longTermCapGain: finite,
  otherIncome: finite,
  adjustments: finite,
  seHealthInsurance: finite.min(0),
  retirementContributions: finite.min(0),
  hsaContribution: finite.min(0),
  itemized: z.object({
    stateLocalTaxesPaid: finite.min(0),
    mortgageInterest: finite.min(0),
    charitable: finite.min(0),
    other: finite.min(0),
  }),
  dependentsUnder17: z.number().int().min(0).max(20),
  otherDependents: z.number().int().min(0).max(20),
  withholding: finite.min(0),
  estimatedPayments: finite.min(0),
  qbiReduction: finite,
  otherCredits: finite.min(0),
  corpTaxPaid: finite.min(0),
  otherTaxes: finite,
  ptetPaid: finite.min(0),
});

// ── inputs_schema checker ────────────────────────────────────────────────

interface JsonSchemaProperty {
  type?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
}

export interface InputsSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface ParamError {
  strategyId: string;
  field: string;
  message: string;
}

export function validateParams(
  strategyId: string,
  params: Record<string, unknown>,
  schema: InputsSchema | null | undefined,
  opts: { checkRequired?: boolean } = {},
): ParamError[] {
  if (!schema || typeof schema !== 'object') return [];
  const errors: ParamError[] = [];
  const properties = schema.properties ?? {};
  // Required-ness is enforced at COMPUTE time, not on scenario writes: the
  // UI persists a selection first and collects params after, so rejecting
  // an incomplete selection would make strategies unselectable. Type/
  // range/enum checks always run — a wrong-typed value is never "not yet
  // entered".
  if (opts.checkRequired ?? true) {
    for (const field of schema.required ?? []) {
      if (params[field] === undefined || params[field] === null || params[field] === '') {
        errors.push({ strategyId, field, message: 'required parameter missing' });
      }
    }
  }
  for (const [field, value] of Object.entries(params)) {
    const prop = properties[field];
    if (!prop) continue; // unknown extras are tolerated (modules clamp defensively)
    if (value === undefined || value === null) continue;
    if (prop.type === 'number' && typeof value !== 'number') {
      errors.push({ strategyId, field, message: 'must be a number' });
      continue;
    }
    if (prop.type === 'string' && typeof value !== 'string') {
      errors.push({ strategyId, field, message: 'must be a string' });
      continue;
    }
    if (prop.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ strategyId, field, message: 'must be a boolean' });
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        errors.push({ strategyId, field, message: 'must be finite' });
        continue;
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        errors.push({ strategyId, field, message: `must be ≥ ${prop.minimum}` });
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        errors.push({ strategyId, field, message: `must be ≤ ${prop.maximum}` });
      }
    }
    if (prop.enum && !prop.enum.includes(value)) {
      errors.push({ strategyId, field, message: `must be one of ${prop.enum.join(', ')}` });
    }
  }
  return errors;
}
