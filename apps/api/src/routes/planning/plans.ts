// TP-6 — plan CRUD, scenarios, and the compute endpoint. Compute writes
// plan_results pinned to {table_set_id, engine_version,
// strategy_versions} so re-publishing content never changes an issued
// plan. Freeze at ≥ presented arrives with the TP-8 workflow.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  deliverables,
  engagements,
  plans,
  plan_scenarios,
  plan_results,
  research_archives,
  strategies as strategiesTable,
  strategy_versions,
  table_sets,
  users,
} from '@vibe/db/schema';
import { composeScenario, ENGINE_VERSION, type ScenarioTransform } from '@vibe/engine';
import { resolveApply } from '@vibe/strategies';
import type { BaselineProfile, StrategySelection, TableSetPayload } from '@vibe/shared';
import { audit } from '../../lib/audit.js';
import { findAttachableClient } from '../clients/index.js';
import {
  baselineProfileSchema,
  validateParams,
  type InputsSchema,
  type ParamError,
} from '../../lib/planning/validate.js';

export const plansRouter = Router();

const uuidSchema = z.string().uuid();

// Statuses at/after which results and profile are frozen (TP-8 enforces
// transitions; compute respects the freeze from day one).
export const FROZEN_STATUSES = ['presented', 'engaged', 'delivered', 'archived'];

const emptyProfile: BaselineProfile = {
  filingStatus: 'mfj',
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
};

async function currentTableSet() {
  const [row] = await getDb()
    .select()
    .from(table_sets)
    .where(eq(table_sets.status, 'published'))
    .orderBy(desc(table_sets.tax_year), desc(table_sets.version))
    .limit(1);
  return row ?? null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────
const createSchema = z.object({
  client_id: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  years: z.number().int().min(1).max(10).optional(),
  growth_pct: z.number().min(-20).max(50).optional(),
});

plansRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const client = await findAttachableClient(parsed.data.client_id);
  if (!client) {
    res.status(400).json({ error: 'unknown_or_merged_client' });
    return;
  }
  const ts = await currentTableSet();
  if (!ts) {
    res.status(503).json({ error: 'no_published_table_set' });
    return;
  }
  const [plan] = await getDb()
    .insert(plans)
    .values({
      client_id: client.id,
      title: parsed.data.title ?? `Plan for ${client.name}`,
      baseline_profile: emptyProfile,
      years: parsed.data.years ?? 5,
      growth_pct: String(parsed.data.growth_pct ?? 3),
      table_set_id: ts.id,
      engine_version: ENGINE_VERSION,
      created_by: req.auth!.user_id,
      assigned_to: req.auth!.user_id,
    })
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.create',
    target_type: 'plan',
    target_id: plan!.id,
    metadata: { client_id: client.id },
    ip: req.ip,
  });
  // A default scenario so the picker has somewhere to land selections.
  await getDb().insert(plan_scenarios).values({ plan_id: plan!.id, label: 'Scenario A' });
  res.status(201).json({ plan });
});

plansRouter.get('/', async (req, res) => {
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null;
  if (clientId && !uuidSchema.safeParse(clientId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid client_id' });
    return;
  }
  const where = clientId ? eq(plans.client_id, clientId) : undefined;
  const rows = await getDb()
    .select()
    .from(plans)
    .where(where)
    .orderBy(desc(plans.updated_at))
    .limit(200);
  res.json({ plans: rows });
});

plansRouter.get('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const scenarios = await db
    .select()
    .from(plan_scenarios)
    .where(eq(plan_scenarios.plan_id, plan.id))
    .orderBy(plan_scenarios.created_at);
  const results = await db
    .select()
    .from(plan_results)
    .where(eq(plan_results.plan_id, plan.id))
    .orderBy(plan_results.year);
  res.json({ plan, scenarios, results });
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  baseline_profile: z.record(z.unknown()).optional(),
  years: z.number().int().min(1).max(10).optional(),
  growth_pct: z.number().min(-20).max(50).optional(),
  fee_plan: z.object({ flatFee: z.number().optional(), note: z.string().optional() }).optional(),
  reviewer_id: z.string().uuid().nullable().optional(),
});

plansRouter.patch('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Frozen plans: only post-freeze bookkeeping fields (fee_plan,
  // reviewer_id) stay mutable. title/years/growth would contradict the
  // pinned results an issued plan carries.
  if (FROZEN_STATUSES.includes(plan.status)) {
    const attempted = Object.keys(parsed.data);
    const allowedFrozen = new Set(['fee_plan', 'reviewer_id']);
    if (attempted.some((k) => !allowedFrozen.has(k))) {
      res.status(409).json({ error: 'plan_frozen' });
      return;
    }
  }
  if (parsed.data.baseline_profile !== undefined) {
    const profileCheck = baselineProfileSchema.safeParse(parsed.data.baseline_profile);
    if (!profileCheck.success) {
      res.status(400).json({ error: 'invalid_profile', detail: profileCheck.error.flatten() });
      return;
    }
  }
  if (parsed.data.reviewer_id != null) {
    const [reviewer] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, parsed.data.reviewer_id))
      .limit(1);
    if (!reviewer) {
      res.status(400).json({ error: 'unknown_reviewer' });
      return;
    }
  }
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.data.title !== undefined) update.title = parsed.data.title;
  if (parsed.data.baseline_profile !== undefined)
    update.baseline_profile = parsed.data.baseline_profile;
  if (parsed.data.years !== undefined) update.years = parsed.data.years;
  if (parsed.data.growth_pct !== undefined) update.growth_pct = String(parsed.data.growth_pct);
  if (parsed.data.fee_plan !== undefined) update.fee_plan = parsed.data.fee_plan;
  if (parsed.data.reviewer_id !== undefined) update.reviewer_id = parsed.data.reviewer_id;
  // Editing the profile invalidates review sign-off: what would be
  // presented is no longer what was ticked (ordering-bypass guard).
  if (plan.status === 'in-review' && parsed.data.baseline_profile !== undefined) {
    update.review_state = {};
  }
  const [row] = await db.update(plans).set(update).where(eq(plans.id, plan.id)).returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.update',
    target_type: 'plan',
    target_id: plan.id,
    metadata: { client_id: plan.client_id, fields: Object.keys(parsed.data) },
    ip: req.ip,
  });
  res.json({ plan: row });
});

plansRouter.delete('/:id', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (plan.status !== 'draft') {
    res.status(409).json({ error: 'only_draft_plans_deletable' });
    return;
  }
  // Detach/remove dependents that carry NO ACTION FKs: an engagement row
  // (created by merely viewing the engagement tab), advisor deliverables
  // rendered on a draft, and archives filed against the plan would each
  // otherwise abort the delete with a raw FK violation.
  await db.transaction(async (tx) => {
    await tx.delete(engagements).where(eq(engagements.plan_id, plan.id));
    await tx.delete(deliverables).where(eq(deliverables.plan_id, plan.id));
    await tx
      .update(research_archives)
      .set({ plan_id: null, strategy_id: null })
      .where(eq(research_archives.plan_id, plan.id));
    await tx.delete(plans).where(eq(plans.id, plan.id));
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.delete',
    target_type: 'plan',
    target_id: plan.id,
    metadata: { client_id: plan.client_id },
    ip: req.ip,
  });
  res.status(204).end();
});

// ── Scenarios ────────────────────────────────────────────────────────────
const scenarioSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  selections: z
    .array(
      z.object({
        strategyId: z.string().min(1),
        version: z.string().min(1),
        params: z.record(z.unknown()).default({}),
      }),
    )
    .optional(),
});

/** Selection params are checked against each strategy's PUBLISHED inputs
 *  schema — a missing required parameter previously computed silently as
 *  $0 and overstated savings. */
async function validateSelections(selections: StrategySelection[]): Promise<ParamError[]> {
  if (selections.length === 0) return [];
  const db = getDb();
  const ids = Array.from(new Set(selections.map((s) => s.strategyId)));
  const rows = await db
    .select({
      strategy_id: strategy_versions.strategy_id,
      inputs_schema: strategy_versions.inputs_schema,
    })
    .from(strategy_versions)
    .innerJoin(strategiesTable, eq(strategiesTable.current_version_id, strategy_versions.id))
    .where(inArray(strategy_versions.strategy_id, ids));
  const schemas = new Map(rows.map((r) => [r.strategy_id, r.inputs_schema as InputsSchema]));
  return selections.flatMap((sel) =>
    validateParams(sel.strategyId, sel.params ?? {}, schemas.get(sel.strategyId)),
  );
}

/** Any change to what would be presented invalidates review sign-off. */
async function clearReviewTicksIfInReview(planId: string, status: string): Promise<void> {
  if (status !== 'in-review') return;
  await getDb().update(plans).set({ review_state: {} }).where(eq(plans.id, planId));
}

plansRouter.post('/:id/scenarios', async (req, res) => {
  const parsed = scenarioSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(req.params.id).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (FROZEN_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_frozen' });
    return;
  }
  const selections = (parsed.data.selections ?? []) as StrategySelection[];
  const paramErrors = await validateSelections(selections);
  if (paramErrors.length > 0) {
    res.status(400).json({ error: 'invalid_params', detail: paramErrors });
    return;
  }
  const [scenario] = await db
    .insert(plan_scenarios)
    .values({
      plan_id: plan.id,
      label: parsed.data.label ?? 'Scenario',
      selections,
    })
    .returning();
  await clearReviewTicksIfInReview(plan.id, plan.status);
  res.status(201).json({ scenario });
});

plansRouter.patch('/:id/scenarios/:scenarioId', async (req, res) => {
  const parsed = scenarioSchema.safeParse(req.body ?? {});
  if (
    !uuidSchema.safeParse(req.params.id).success ||
    !uuidSchema.safeParse(req.params.scenarioId).success ||
    !parsed.success
  ) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  if (parsed.data.label === undefined && parsed.data.selections === undefined) {
    res.status(400).json({ error: 'bad_request', detail: 'nothing to update' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (FROZEN_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_frozen' });
    return;
  }
  if (parsed.data.selections !== undefined) {
    const paramErrors = await validateSelections(parsed.data.selections as StrategySelection[]);
    if (paramErrors.length > 0) {
      res.status(400).json({ error: 'invalid_params', detail: paramErrors });
      return;
    }
  }
  const update: Record<string, unknown> = {};
  if (parsed.data.label !== undefined) update.label = parsed.data.label;
  if (parsed.data.selections !== undefined) update.selections = parsed.data.selections;
  const [row] = await db
    .update(plan_scenarios)
    .set(update)
    .where(and(eq(plan_scenarios.id, req.params.scenarioId), eq(plan_scenarios.plan_id, plan.id)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (parsed.data.selections !== undefined) {
    await clearReviewTicksIfInReview(plan.id, plan.status);
  }
  res.json({ scenario: row });
});

// ── Compute ──────────────────────────────────────────────────────────────
plansRouter.post('/:id/compute', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, req.params.id)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (FROZEN_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_frozen' });
    return;
  }
  const [ts] = await db
    .select()
    .from(table_sets)
    .where(eq(table_sets.id, plan.table_set_id))
    .limit(1);
  if (!ts) {
    res.status(500).json({ error: 'table_set_missing' });
    return;
  }
  const tableSet = ts.payload as TableSetPayload;
  const scenarios = await db
    .select()
    .from(plan_scenarios)
    .where(eq(plan_scenarios.plan_id, plan.id));

  // Resolve every selected strategy version once.
  const selectedIds = Array.from(
    new Set(scenarios.flatMap((s) => s.selections.map((sel) => sel.strategyId))),
  );
  const versions =
    selectedIds.length > 0
      ? await db
          .select()
          .from(strategy_versions)
          .where(
            and(
              inArray(strategy_versions.strategy_id, selectedIds),
              eq(strategy_versions.status, 'published'),
            ),
          )
      : [];
  const versionByKey = new Map(versions.map((v) => [`${v.strategy_id}@${v.semver}`, v]));

  const startYear = ts.tax_year;
  const growthPct = Number(plan.growth_pct);

  const toTransforms = (selections: StrategySelection[]): ScenarioTransform[] =>
    selections.map((sel) => {
      const v = versionByKey.get(`${sel.strategyId}@${sel.version}`);
      if (!v) throw Object.assign(new Error('unknown_strategy_version'), { status: 400 });
      if (!v.apply_module_ref || v.apply_order === null) {
        throw Object.assign(new Error(`advisory_strategy_not_computable:${sel.strategyId}`), {
          status: 400,
        });
      }
      return {
        strategyId: sel.strategyId,
        applyOrder: v.apply_order,
        params: sel.params,
        apply: resolveApply(v.apply_module_ref),
      };
    });

  const baselineRun = composeScenario({
    baseline: plan.baseline_profile,
    transforms: [],
    years: plan.years,
    growthPct,
    tableSet,
    startYear,
  });

  const scenarioRuns: Array<{
    scenarioId: string;
    years: typeof baselineRun.years;
    notes: string[];
    strategyVersions: Record<string, string>;
  }> = [];
  try {
    for (const s of scenarios) {
      const run = composeScenario({
        baseline: plan.baseline_profile,
        transforms: toTransforms(s.selections),
        years: plan.years,
        growthPct,
        tableSet,
        startYear,
      });
      scenarioRuns.push({
        scenarioId: s.id,
        years: run.years,
        notes: run.notes,
        strategyVersions: Object.fromEntries(s.selections.map((x) => [x.strategyId, x.version])),
      });
    }
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: (err as Error).message });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(plan_results).where(eq(plan_results.plan_id, plan.id));
    for (const y of baselineRun.years) {
      await tx.insert(plan_results).values({
        plan_id: plan.id,
        scenario_id: null,
        year: y.year,
        result: y,
        table_set_id: ts.id,
        engine_version: ENGINE_VERSION,
        strategy_versions: {},
      });
    }
    for (const run of scenarioRuns) {
      for (const y of run.years) {
        await tx.insert(plan_results).values({
          plan_id: plan.id,
          scenario_id: run.scenarioId,
          year: y.year,
          result: y,
          table_set_id: ts.id,
          engine_version: ENGINE_VERSION,
          strategy_versions: run.strategyVersions,
        });
      }
    }
    await tx
      .update(plans)
      .set({
        updated_at: new Date(),
        // Recomputing while in review invalidates existing sign-off.
        ...(plan.status === 'in-review' ? { review_state: {} } : {}),
      })
      .where(eq(plans.id, plan.id));
  });

  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.compute',
    target_type: 'plan',
    target_id: plan.id,
    metadata: {
      client_id: plan.client_id,
      table_set_id: ts.id,
      engine_version: ENGINE_VERSION,
      scenarios: scenarioRuns.length,
    },
    ip: req.ip,
  });

  res.json({
    baseline: baselineRun.years,
    scenarios: scenarioRuns,
  });
});
