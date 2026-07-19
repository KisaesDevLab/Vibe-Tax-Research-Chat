// TP-6 — published-strategy listing + declarative suggestions. Content
// comes from strategy_versions rows (hot-updatable); suggestions run the
// shared predicate-AST evaluator server-side.
import { Router } from 'express';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { strategies, strategy_versions } from '@vibe/db/schema';
import { evaluateSuggestRule, type SuggestRule } from '@vibe/shared';

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
    .where(and(eq(strategy_versions.status, 'published')));
  // Only the strategy's CURRENT version is offered for new selections.
  return rows.filter((r) => r.current_version_id === r.version_id);
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

const suggestSchema = z.object({ profile: z.record(z.unknown()) });

planningStrategiesRouter.post('/suggest', async (req, res) => {
  const parsed = suggestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const rows = await loadPublished();
  const hits: Array<{ strategyId: string; reason: string }> = [];
  for (const r of rows) {
    if (!r.suggest_rule) continue;
    const result = evaluateSuggestRule(
      parsed.data.profile,
      r.suggest_rule as unknown as SuggestRule,
    );
    if (result.matched) hits.push({ strategyId: r.strategy_id, reason: result.reason });
  }
  res.json({ suggestions: hits });
});
