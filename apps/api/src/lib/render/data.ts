// TP-9 — assembles the RenderData a template needs from a plan id:
// client, computed results (baseline + first scenario), and the selected
// strategies' published content.
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  plans,
  plan_scenarios,
  plan_results,
  plan_memos,
  clients,
  strategies,
  strategy_versions,
} from '@vibe/db/schema';
import type { PlanDTO, YearResult } from '@vibe/shared';
import { loadBranding } from './theme.js';
import type { RenderData, StrategyRenderData } from './types.js';

export async function buildRenderData(
  planId: string,
  revealStrategies: boolean,
): Promise<RenderData> {
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) throw new Error('plan_not_found');
  const [client] = await db.select().from(clients).where(eq(clients.id, plan.client_id)).limit(1);
  const scenarios = await db
    .select()
    .from(plan_scenarios)
    .where(eq(plan_scenarios.plan_id, plan.id))
    .orderBy(plan_scenarios.created_at);
  const primary = scenarios[0] ?? null;
  const results = await db
    .select()
    .from(plan_results)
    .where(eq(plan_results.plan_id, plan.id))
    .orderBy(plan_results.year);
  const baseline = results.filter((r) => r.scenario_id === null).map((r) => r.result as YearResult);
  const scenarioYears = primary
    ? results.filter((r) => r.scenario_id === primary.id).map((r) => r.result as YearResult)
    : [];
  if (baseline.length === 0) throw new Error('plan_not_computed');

  const ids = Array.from(new Set((primary?.selections ?? []).map((s) => s.strategyId)));
  const strategyRows =
    ids.length > 0
      ? await db
          .select({
            strategy_id: strategy_versions.strategy_id,
            version_id: strategy_versions.id,
            content: strategy_versions.content,
            current: strategies.current_version_id,
          })
          .from(strategy_versions)
          .innerJoin(strategies, eq(strategies.id, strategy_versions.strategy_id))
          .where(
            and(
              inArray(strategy_versions.strategy_id, ids),
              eq(strategy_versions.status, 'published'),
            ),
          )
      : [];
  const strategyData: StrategyRenderData[] = strategyRows
    .filter((r) => r.current === r.version_id)
    .map((r) => {
      const c = r.content as unknown as StrategyRenderData & { name: string };
      return {
        id: r.strategy_id,
        name: c.name,
        modeled: (c as { modeled?: boolean }).modeled ?? false,
        riskRating: (c as { riskRating?: string }).riskRating ?? 'low',
        typicalSavingsBand: (c as { typicalSavingsBand?: string }).typicalSavingsBand ?? '',
        client: c.client,
        advisor: c.advisor,
        engagement: c.engagement,
      };
    });

  const [memoRow] = await db
    .select()
    .from(plan_memos)
    .where(eq(plan_memos.plan_id, plan.id))
    .limit(1);

  return {
    branding: await loadBranding(),
    plan: plan as unknown as PlanDTO,
    clientName: client?.name ?? '—',
    baseline,
    scenario: scenarioYears,
    scenarioLabel: primary?.label ?? 'Scenario',
    strategies: strategyData,
    revealStrategies,
    generatedAt: new Date().toLocaleString('en-US'),
    memo:
      memoRow && memoRow.body_markdown.trim()
        ? {
            bodyMarkdown: memoRow.body_markdown,
            claudeDrafted: memoRow.claude_drafted,
            updatedAt: memoRow.updated_at.toISOString(),
          }
        : null,
  };
}
