// TP-6 — published-strategy listing + declarative suggestions. Content
// comes from strategy_versions rows (hot-updatable); suggestions run the
// shared predicate-AST evaluator server-side.
//
// TP-5a: POST /suggest is plan-scoped ({plan_id} — the server loads the
// baseline profile and the plan's latest fact snapshot) and tri-state:
// every rule-carrying strategy comes back with status matched | toConfirm |
// excluded plus the English leaf renderings. The legacy {profile} body
// stays accepted (no facts context → facts leaves evaluate unknown).
import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { plans, plan_fact_snapshots, strategies, strategy_versions } from '@vibe/db/schema';
import { evaluateSuggestRuleTri, type SuggestRule } from '@vibe/shared';

export const planningStrategiesRouter = Router();

async function loadPublished() {
  const db = getDb();
  const rows = await db
    .select({
      strategy_id: strategy_versions.strategy_id,
      version_id: strategy_versions.id,
      semver: strategy_versions.semver,
      content: strategy_versions.content,
      inputs_schema: strategy_versions.inputs_schema,
      suggest_rule: strategy_versions.suggest_rule,
      apply_module_ref: strategy_versions.apply_module_ref,
      apply_order: strategy_versions.apply_order,
      current_version_id: strategies.current_version_id,
    })
    .from(strategy_versions)
    .innerJoin(strategies, eq(strategies.id, strategy_versions.strategy_id))
    // Retired strategies never appear in the picker or suggestions;
    // plans that already pinned a version keep computing regardless.
    .where(and(eq(strategy_versions.status, 'published'), isNull(strategies.retired_at)));
  // Only the strategy's CURRENT version is offered for new selections.
  return rows.filter((r) => r.current_version_id === r.version_id);
}

// TP-5a — /suggest runs the full catalog per call; a short TTL keeps the
// hot path off the DB. Cost: an admin publish takes ≤30s to reach
// suggestions (accepted, documented).
const PUBLISHED_CACHE_TTL_MS = 30_000;
let publishedCache: { rows: Awaited<ReturnType<typeof loadPublished>>; at: number } | null = null;

async function loadPublishedCached() {
  if (publishedCache && Date.now() - publishedCache.at < PUBLISHED_CACHE_TTL_MS) {
    return publishedCache.rows;
  }
  const rows = await loadPublished();
  publishedCache = { rows, at: Date.now() };
  return rows;
}

planningStrategiesRouter.get('/', async (_req, res) => {
  const rows = await loadPublished();
  res.json({
    strategies: rows.map((r) => {
      const c = r.content as Record<string, unknown>;
      return {
        id: r.strategy_id,
        semver: r.semver,
        name: c.name,
        category: c.category,
        modeled: c.modeled,
        complexity: c.complexity,
        riskRating: c.riskRating,
        typicalSavingsBand: c.typicalSavingsBand,
        entityTypes: c.entityTypes,
        advisor: c.advisor,
        client: c.client,
        engagement: c.engagement,
        inputsSchema: r.inputs_schema,
        applyOrder: r.apply_order,
        applyModuleRef: r.apply_module_ref,
      };
    }),
  });
});

const suggestSchema = z
  .object({
    plan_id: z.string().uuid().optional(),
    profile: z.record(z.unknown()).optional(),
  })
  .refine((v) => v.plan_id !== undefined || v.profile !== undefined, {
    message: 'plan_id or profile required',
  });

planningStrategiesRouter.post('/suggest', async (req, res) => {
  const parsed = suggestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  let profile: Record<string, unknown>;
  let facts: Record<string, unknown> | null = null;
  if (parsed.data.plan_id) {
    const db = getDb();
    const [plan] = await db.select().from(plans).where(eq(plans.id, parsed.data.plan_id)).limit(1);
    if (!plan) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    profile = plan.baseline_profile as unknown as Record<string, unknown>;
    // Latest snapshot wins: after freeze that's the review_frozen one.
    const [snap] = await db
      .select()
      .from(plan_fact_snapshots)
      .where(eq(plan_fact_snapshots.plan_id, plan.id))
      .orderBy(desc(plan_fact_snapshots.snapshot_at))
      .limit(1);
    facts = (snap?.facts as unknown as Record<string, unknown>) ?? null;
  } else {
    profile = parsed.data.profile!;
  }

  const rows = await loadPublishedCached();
  const suggestions = [];
  for (const r of rows) {
    if (!r.suggest_rule) continue;
    const result = evaluateSuggestRuleTri(
      { profile, facts },
      r.suggest_rule as unknown as SuggestRule,
    );
    suggestions.push({
      strategyId: r.strategy_id,
      status: result.status,
      reason: result.reason,
      matched: result.matched,
      toConfirm: result.toConfirm,
      excluded: result.excluded,
    });
  }
  res.json({ suggestions, has_fact_snapshot: facts !== null });
});
