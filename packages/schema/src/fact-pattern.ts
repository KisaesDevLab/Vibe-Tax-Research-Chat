// TP-3a — zod mirror of the canonical fact schema
// (packages/shared/src/facts/fact-schema.json). fact-paths.test.ts guards the
// two against drift. Strict objects: unknown keys are rejected so LLM
// extraction output can't smuggle fields past the schema.
import { z } from 'zod';
import type { FactCandidate, FactPattern } from '@vibe/shared';
import { FACT_SECTIONS } from '@vibe/shared';
import type { ValidationError } from './types.js';

export const factSourceSchema = z
  .object({
    documentId: z.string().uuid(),
    page: z.number().int().min(1),
    span: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    method: z.enum(['extracted', 'tb_sync', 'staff_entered', 'chat_confirmed']),
  })
  .strict();

const sources = z.array(factSourceSchema).nullish();

const entitySchema = z
  .object({
    type: z
      .enum([
        'individual',
        'sole_prop',
        's_corp',
        'c_corp',
        'partnership',
        'smllc',
        'trust',
        'nonprofit',
        'other',
      ])
      .nullish(),
    formationState: z.string().length(2).nullish(),
    fiscalYearEnd: z
      .string()
      .regex(/^\d{2}-\d{2}$/)
      .nullish(),
    sCorpEffectiveDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish(),
    accountingMethod: z.enum(['cash', 'accrual', 'hybrid']).nullish(),
    notes: z.string().nullish(),
    sources,
  })
  .strict();

const ownershipSchema = z
  .object({
    owner: z.string().min(1),
    pct: z.number().min(0).max(100),
    role: z.enum(['shareholder', 'partner', 'member', 'officer', 'trustee', 'other']),
    relatedParty: z.boolean().nullish(),
    sources,
  })
  .strict();

const stateFootprintSchema = z
  .object({
    state: z.string().length(2),
    nexusBasis: z.enum(['domicile', 'physical', 'economic', 'payroll', 'property', 'other']),
    ptetElected: z.boolean().nullish(),
    sources,
  })
  .strict();

const incomeCharacter = z.enum([
  'w2',
  'se',
  'k1_active',
  'k1_passive',
  'rental',
  'portfolio',
  'capital_gain',
  'retirement',
  'other',
]);

const incomeSchema = z
  .object({
    characters: z.array(incomeCharacter),
    sources: z.array(
      z
        .object({
          label: z.string().min(1),
          character: incomeCharacter,
          approxBand: z.enum(['under_100k', '100k_500k', '500k_1m', 'over_1m']).nullish(),
          sources,
        })
        .strict(),
    ),
    notes: z.string().nullish(),
  })
  .strict();

const electionSchema = z
  .object({
    code: z.string().min(1),
    since: z
      .string()
      .regex(/^\d{4}$/)
      .nullish(),
    note: z.string().nullish(),
    sources,
  })
  .strict();

const carryforwardSchema = z
  .object({
    type: z.enum([
      'nol',
      'capital_loss',
      'charitable',
      'passive_loss',
      'foreign_tax_credit',
      'amt_credit',
      'other',
    ]),
    amount: z.number(),
    expires: z
      .string()
      .regex(/^\d{4}$/)
      .nullish(),
    sources,
  })
  .strict();

const propertySchema = z
  .object({
    kind: z.enum([
      'real_estate',
      'residential_rental',
      'commercial',
      'vehicle',
      'equipment',
      'intangible',
      'other',
    ]),
    description: z.string().nullish(),
    placedInService: z
      .string()
      .regex(/^\d{4}(-\d{2}-\d{2})?$/)
      .nullish(),
    basis: z.number().nullish(),
    method: z.enum(['macrs', 'sl', 'bonus', 'sec179', 'other']).nullish(),
    sources,
  })
  .strict();

const householdSchema = z
  .object({
    filingStatus: z.enum(['single', 'mfj', 'mfs', 'hoh']).nullable(),
    dependents: z.array(
      z
        .object({
          ageBand: z.enum(['under_6', '6_12', '13_17', '18_23', 'adult']).nullish(),
          relationship: z.enum(['child', 'parent', 'other']),
        })
        .strict(),
    ),
    sources,
  })
  .strict();

const lifeEventSchema = z
  .object({
    year: z.number().int().min(1900).max(2200),
    event: z.enum([
      'marriage',
      'divorce',
      'birth',
      'death',
      'home_purchase',
      'home_sale',
      'relocation',
      'business_start',
      'business_sale',
      'retirement',
      'inheritance',
      'other',
    ]),
    note: z.string().nullish(),
    sources,
  })
  .strict();

const openQuestionSchema = z
  .object({
    id: z.string().nullish(),
    question: z.string().min(1),
    raisedBy: z.enum(['staff', 'system', 'client']),
    status: z.enum(['open', 'answered', 'dismissed']),
    sources,
  })
  .strict();

export const factPatternSchema: z.ZodType<FactPattern> = z
  .object({
    entity: entitySchema,
    ownership: z.array(ownershipSchema),
    stateFootprint: z.array(stateFootprintSchema),
    income: incomeSchema,
    electionsInEffect: z.array(electionSchema),
    carryforwards: z.array(carryforwardSchema),
    property: z.array(propertySchema),
    household: householdSchema,
    lifeEvents: z.array(lifeEventSchema),
    openQuestions: z.array(openQuestionSchema),
    narrative: z.string(),
  })
  .strict() as z.ZodType<FactPattern>;

export function validateFactPattern(
  record: unknown,
): { ok: true; facts: FactPattern } | { ok: false; errors: ValidationError[] } {
  const parsed = factPatternSchema.safeParse(record);
  if (parsed.success) return { ok: true, facts: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      gate: 'schema',
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** One extraction candidate as the LLM must emit it (pre-mint: no id/status). */
export const factCandidateEmitSchema = z
  .object({
    path: z.string().min(1),
    section: z.enum(FACT_SECTIONS),
    value: z.unknown(),
    display: z.string().min(1),
    page: z.number().int().min(1),
  })
  .strict();

export type FactCandidateEmit = z.infer<typeof factCandidateEmitSchema>;

/** Full persisted candidate shape (used to validate stored rows in tests). */
export const factCandidateSchema: z.ZodType<FactCandidate> = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    section: z.enum(FACT_SECTIONS),
    value: z.unknown(),
    display: z.string().min(1),
    sources: z.array(factSourceSchema),
    status: z.enum(['pending', 'accepted', 'rejected']),
    editedValue: z.unknown().optional(),
    resolvedBy: z.string().optional(),
    resolvedAt: z.string().optional(),
    resolvedFactPatternId: z.string().optional(),
  })
  .strict() as unknown as z.ZodType<FactCandidate>;
