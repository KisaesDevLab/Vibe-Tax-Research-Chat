// TP-8 — transitions, review state, research links, and the "Research
// this" launcher. Mounted under /plans/:id (mergeParams).
import { Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  plans,
  plan_scenarios,
  plan_research_links,
  research_archives,
  strategies,
  strategy_versions,
  chats,
  messages,
} from '@vibe/db/schema';
import type { PlanStatus, StrategySelection } from '@vibe/shared';
import { audit } from '../../lib/audit.js';
import { canTransition, evaluateReviewGate } from '../../lib/planning/workflow.js';

export const planWorkflowRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();

async function loadPlan(planId: string) {
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  return plan ?? null;
}

async function collectGateInput(planId: string) {
  const db = getDb();
  const scenarios = await db
    .select()
    .from(plan_scenarios)
    .where(eq(plan_scenarios.plan_id, planId));
  const selections: StrategySelection[] = scenarios.flatMap((s) => s.selections);
  const ids = Array.from(new Set(selections.map((s) => s.strategyId)));
  const records = new Map<string, { riskRating: string; reviewChecklist: string[] }>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        strategy_id: strategy_versions.strategy_id,
        version_id: strategy_versions.id,
        content: strategy_versions.content,
        current: strategies.current_version_id,
      })
      .from(strategy_versions)
      .innerJoin(strategies, eq(strategies.id, strategy_versions.strategy_id))
      .where(
        and(inArray(strategy_versions.strategy_id, ids), eq(strategy_versions.status, 'published')),
      );
    for (const r of rows) {
      if (r.current !== r.version_id) continue;
      const c = r.content as {
        riskRating?: string;
        advisor?: { reviewChecklist?: string[] };
      };
      records.set(r.strategy_id, {
        riskRating: c.riskRating ?? 'low',
        reviewChecklist: c.advisor?.reviewChecklist ?? [],
      });
    }
  }
  const links = await db
    .select({
      strategy_id: plan_research_links.strategy_id,
      archive_status: research_archives.status,
    })
    .from(plan_research_links)
    .innerJoin(research_archives, eq(research_archives.id, plan_research_links.research_archive_id))
    .where(eq(plan_research_links.plan_id, planId));
  const linkedStrategies = new Set(
    links.filter((l) => l.archive_status === 'active' && l.strategy_id).map((l) => l.strategy_id!),
  );
  return { selections, records, linkedStrategies };
}

// ── Review state (checklist ticks) ───────────────────────────────────────
const reviewStateSchema = z.object({ review_state: z.record(z.boolean()) });

planWorkflowRouter.patch('/review-state', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = reviewStateSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (plan.status !== 'in-review') {
    res.status(409).json({ error: 'not_in_review' });
    return;
  }
  const [row] = await getDb()
    .update(plans)
    .set({ review_state: parsed.data.review_state, updated_at: new Date() })
    .where(eq(plans.id, plan.id))
    .returning();
  res.json({ plan: row });
});

// ── Gate preview (drives the review screen) ──────────────────────────────
planWorkflowRouter.get('/review-gate', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const input = await collectGateInput(plan.id);
  const gate = evaluateReviewGate({
    ...input,
    reviewState: plan.review_state,
    reviewerId: plan.reviewer_id,
    preparerId: plan.created_by,
  });
  res.json({
    gate,
    checklist: Array.from(input.records.entries()).map(([strategyId, r]) => ({
      strategyId,
      riskRating: r.riskRating,
      items: r.reviewChecklist,
      linked: input.linkedStrategies.has(strategyId),
      selected: input.selections.some((s) => s.strategyId === strategyId),
    })),
  });
});

// ── Transition ───────────────────────────────────────────────────────────
const transitionSchema = z.object({
  to: z.enum(['draft', 'in-review', 'presented', 'engaged', 'delivered', 'archived']),
});

planWorkflowRouter.post('/transition', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = transitionSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const to = parsed.data.to;
  if (!canTransition(plan.status as PlanStatus, to)) {
    res.status(409).json({ error: 'invalid_transition', from: plan.status, to });
    return;
  }
  if (plan.status === 'in-review' && to === 'presented') {
    const input = await collectGateInput(plan.id);
    const gate = evaluateReviewGate({
      ...input,
      reviewState: plan.review_state,
      reviewerId: plan.reviewer_id,
      preparerId: plan.created_by,
    });
    if (!gate.ok) {
      res.status(409).json({ error: 'review_gate_failed', failures: gate.failures });
      return;
    }
  }
  const [row] = await getDb()
    .update(plans)
    .set({ status: to, updated_at: new Date() })
    .where(eq(plans.id, plan.id))
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.transition',
    target_type: 'plan',
    target_id: plan.id,
    metadata: { client_id: plan.client_id, from: plan.status, to },
    ip: req.ip,
  });
  res.json({ plan: row });
});

// ── Research links ───────────────────────────────────────────────────────
planWorkflowRouter.get('/research-links', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const links = await db
    .select({
      id: plan_research_links.id,
      strategy_id: plan_research_links.strategy_id,
      research_archive_id: plan_research_links.research_archive_id,
      title: research_archives.title,
      status: research_archives.status,
      archived_at: research_archives.archived_at,
    })
    .from(plan_research_links)
    .innerJoin(research_archives, eq(research_archives.id, plan_research_links.research_archive_id))
    .where(eq(plan_research_links.plan_id, planId));
  // Candidate archives: the plan's client's active archives.
  const candidates = await db
    .select({
      id: research_archives.id,
      title: research_archives.title,
      topic_tags: research_archives.topic_tags,
      archived_at: research_archives.archived_at,
    })
    .from(research_archives)
    .where(
      and(eq(research_archives.client_id, plan.client_id), eq(research_archives.status, 'active')),
    );
  res.json({ links, candidates });
});

const linkSchema = z.object({
  research_archive_id: z.string().uuid(),
  strategy_id: z.string().min(1).nullable().optional(),
});

planWorkflowRouter.post('/research-links', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = linkSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const [archive] = await db
    .select()
    .from(research_archives)
    .where(eq(research_archives.id, parsed.data.research_archive_id))
    .limit(1);
  if (!archive || archive.status !== 'active') {
    res.status(400).json({ error: 'archive_not_active' });
    return;
  }
  if (archive.client_id !== plan.client_id && !archive.firm_archive) {
    res.status(400).json({ error: 'archive_belongs_to_other_client' });
    return;
  }
  const [link] = await db
    .insert(plan_research_links)
    .values({
      plan_id: plan.id,
      strategy_id: parsed.data.strategy_id ?? null,
      research_archive_id: archive.id,
      created_by: req.auth!.user_id,
    })
    .onConflictDoNothing()
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.research_link.create',
    target_type: 'plan',
    target_id: plan.id,
    metadata: {
      client_id: plan.client_id,
      research_archive_id: archive.id,
      strategy_id: parsed.data.strategy_id ?? null,
    },
    ip: req.ip,
  });
  res.status(201).json({ link: link ?? null });
});

planWorkflowRouter.delete('/research-links/:linkId', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const { linkId } = req.params as { linkId: string };
  if (!uuidSchema.safeParse(planId).success || !uuidSchema.safeParse(linkId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const deleted = await getDb()
    .delete(plan_research_links)
    .where(and(eq(plan_research_links.id, linkId), eq(plan_research_links.plan_id, planId)))
    .returning({ id: plan_research_links.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

// ── "Research this" launcher ─────────────────────────────────────────────
// Creates a Research chat pre-seeded with the strategy's authority list,
// soft-linked to the plan's client. Archiving that chat (and linking it)
// satisfies the elevated-risk gate.
const launchSchema = z.object({ strategy_id: z.string().min(1) });

planWorkflowRouter.post('/research-launch', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = launchSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const [version] = await db
    .select({
      content: strategy_versions.content,
      current: strategies.current_version_id,
      id: strategy_versions.id,
    })
    .from(strategy_versions)
    .innerJoin(strategies, eq(strategies.id, strategy_versions.strategy_id))
    .where(
      and(
        eq(strategy_versions.strategy_id, parsed.data.strategy_id),
        eq(strategy_versions.status, 'published'),
      ),
    );
  if (!version || version.current !== version.id) {
    res.status(404).json({ error: 'strategy_not_found' });
    return;
  }
  const content = version.content as {
    name?: string;
    advisor?: { authority?: Array<{ type: string; cite: string; note?: string }> };
  };
  const authorities = content.advisor?.authority ?? [];
  const seed = [
    `Research request: verify current authority for the "${content.name ?? parsed.data.strategy_id}" strategy before presenting it in a client plan.`,
    '',
    'Authority list to verify (from the strategy record):',
    ...authorities.map((a) => `- [${a.type}] ${a.cite}${a.note ? ` — ${a.note}` : ''}`),
    '',
    'Confirm each authority is current, check for adverse developments (new cases, rulings, or legislation), and summarize anything that changes the risk posture.',
  ].join('\n');

  const [chat] = await db
    .insert(chats)
    .values({
      user_id: req.auth!.user_id,
      title: `Research: ${content.name ?? parsed.data.strategy_id}`,
      client_id: plan.client_id,
    })
    .returning();
  await db.insert(messages).values({
    chat_id: chat!.id,
    role: 'user',
    content: seed,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.research_launch',
    target_type: 'plan',
    target_id: plan.id,
    metadata: {
      client_id: plan.client_id,
      strategy_id: parsed.data.strategy_id,
      chat_id: chat!.id,
    },
    ip: req.ip,
  });
  res.status(201).json({ chat_id: chat!.id });
});
