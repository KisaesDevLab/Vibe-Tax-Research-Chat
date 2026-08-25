// TP-12 — zod schema for the strategy record (docs/strategy-schema.md
// v1.0). This is the first validation gate: structural shape, enums,
// and basic invariants. Content-quality gates (citations, prose,
// completeness) run after this one passes.
import { z } from 'zod';

export const CATEGORIES = [
  'business-expenses',
  'credits-incentives',
  'entity-structure',
  'health-fringe',
  'income-timing',
  'payroll-family',
  'qbi-optimization',
  'real-estate',
  'retirement',
  'succession-exit',
] as const;

export const SAVINGS_BANDS = ['under-5k', '5k-25k', '25k-100k', '100k-plus', 'structural'] as const;

export const ENTITY_TYPES = [
  'sole-prop',
  'single-member-llc',
  's-corp',
  'partnership',
  'c-corp',
  'rental',
  'individual',
] as const;

/** applyOrder composition bands (docs/strategy-schema.md). */
export const APPLY_ORDER_MIN = 10;
export const APPLY_ORDER_MAX = 89;

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'must be MAJOR.MINOR.PATCH');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case');
const nonEmpty = z.string().trim().min(1);

const predicateLeaf = z.object({
  field: nonEmpty,
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']),
  value: z.unknown().optional(),
  // TP-5a — English rendering for matched/toConfirm/excluded lists.
  label: nonEmpty.optional(),
});

type PredicateNode =
  | z.infer<typeof predicateLeaf>
  | { all: PredicateNode[] }
  | { any: PredicateNode[] }
  | { not: PredicateNode };

const predicateNode: z.ZodType<PredicateNode> = z.lazy(() =>
  z.union([
    predicateLeaf,
    z.object({ all: z.array(predicateNode).min(1) }),
    z.object({ any: z.array(predicateNode).min(1) }),
    z.object({ not: predicateNode }),
  ]),
);

const suggestSchema = z
  .object({ reason: nonEmpty })
  .and(
    z.union([
      z.object({ all: z.array(predicateNode).min(1) }),
      z.object({ any: z.array(predicateNode).min(1) }),
      z.object({ not: predicateNode }),
    ]),
  );

const authoritySchema = z.object({
  type: z.enum(['IRC', 'Reg', 'Case', 'Admin']),
  cite: nonEmpty,
  note: nonEmpty,
});

const goldenTestSchema = z.object({
  name: nonEmpty,
  profile: z.record(z.unknown()),
  params: z.record(z.unknown()),
  expect: z.object({
    totalBurdenDelta: z.number(),
    tolerance: z.number().min(0),
  }),
});

const modelSchema = z.object({
  applyOrder: z.number().int().min(APPLY_ORDER_MIN).max(APPLY_ORDER_MAX),
  inputs: z
    .object({ type: z.literal('object') })
    .passthrough()
    .describe('JSON Schema for strategy parameters'),
  apply: z.object({
    module: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*@\d+\.\d+\.\d+$/, 'must be <kebab-id>@<semver>'),
  }),
  mayIncreaseBurden: z.boolean().optional(),
  suggest: suggestSchema,
  goldenTests: z.array(goldenTestSchema).min(2, 'modeled strategies need ≥2 golden tests'),
});

export const strategyRecordSchema = z
  .object({
    id: kebab,
    version: semver,
    status: z.enum(['draft', 'in-review', 'published', 'deprecated']),
    effectiveTaxYears: z.object({
      from: z.number().int().min(2020),
      to: z.number().int().min(2020).nullable(),
    }),
    lastReviewed: isoDate,
    reviewedBy: z.string().nullable(),
    changeLog: z.array(z.object({ version: semver, date: isoDate, note: nonEmpty })).min(1),
    name: nonEmpty,
    category: z.enum(CATEGORIES),
    modeled: z.boolean(),
    complexity: z.number().int().min(1).max(5),
    riskRating: z.enum(['low', 'moderate', 'elevated']),
    entityTypes: z.array(z.enum(ENTITY_TYPES)).min(1),
    typicalSavingsBand: z.enum(SAVINGS_BANDS),
    advisor: z.object({
      summary: nonEmpty,
      mechanics: z.array(nonEmpty).min(3),
      authority: z.array(authoritySchema).min(2),
      requirements: z.array(nonEmpty).min(2),
      risks: z.array(nonEmpty).min(2),
      stateNotes: z.array(nonEmpty).min(1),
      interactions: z.object({
        requires: z.array(kebab),
        conflictsWith: z.array(kebab),
        synergiesWith: z.array(kebab),
      }),
      reviewChecklist: z.array(nonEmpty).min(3),
    }),
    client: z.object({
      teaser: nonEmpty,
      headline: nonEmpty,
      plainEnglish: z.array(nonEmpty).min(2).max(4),
      analogy: nonEmpty,
      benefits: z.array(nonEmpty).min(2),
      steps: z.array(nonEmpty).min(2),
      clientCommitments: z.array(nonEmpty).min(1),
    }),
    engagement: z.object({
      implementationEffort: z.enum(['one-meeting', 'multi-step', 'structural']),
      annualMaintenance: z.array(nonEmpty),
      deliverables: z.array(nonEmpty).min(1),
      feeGuidanceBand: z.string().nullable(),
    }),
    model: modelSchema.optional(),
    suggest: suggestSchema.optional(),
    monitoring: z.object({
      watchAuthorities: z.array(nonEmpty).min(1),
      keywords: z.array(nonEmpty).min(2),
      reviewTriggers: z.array(nonEmpty).min(1),
    }),
  })
  .superRefine((record, ctx) => {
    if (record.modeled && !record.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'modeled strategies must carry a model block',
      });
    }
    if (!record.modeled && record.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: 'advisory strategies must not carry a model block',
      });
    }
    if (!record.modeled && !record.suggest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['suggest'],
        message: 'advisory strategies must carry a top-level suggest rule',
      });
    }
    if (record.model) {
      const moduleId = record.model.apply.module.split('@')[0];
      if (moduleId !== record.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['model', 'apply', 'module'],
          message: `apply module id "${moduleId}" must match record id "${record.id}"`,
        });
      }
    }
    const { from, to } = record.effectiveTaxYears;
    if (to !== null && to < from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effectiveTaxYears', 'to'],
        message: 'to-year precedes from-year',
      });
    }
  });

export type ValidStrategyRecord = z.infer<typeof strategyRecordSchema>;
