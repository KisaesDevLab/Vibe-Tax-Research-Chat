// TP-8a — plan-scoped chat launcher. Mirrors research-launch but persists
// the plan linkage (plan_id + mode='plan' + strategy_id) on the chat so
// the message pipeline assembles fact-snapshot + client-document context
// on every turn. Mounted at /plans/:id/chat BEFORE the /plans/:id workflow
// router in routes/planning/index.ts.
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { chats, messages, plans, strategies, strategy_versions } from '@vibe/db/schema';
import { audit } from '../../lib/audit.js';

export const planChatRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();

const launchSchema = z.object({
  strategy_id: z.string().min(1).max(120).optional(),
  question: z.string().min(1).max(4000).optional(),
});

planChatRouter.post('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = launchSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let strategyName: string | null = null;
  if (parsed.data.strategy_id) {
    const [version] = await db
      .select({ content: strategy_versions.content })
      .from(strategies)
      .innerJoin(strategy_versions, eq(strategy_versions.id, strategies.current_version_id))
      .where(
        and(eq(strategies.id, parsed.data.strategy_id), eq(strategy_versions.status, 'published')),
      );
    if (!version) {
      res.status(404).json({ error: 'strategy_not_found' });
      return;
    }
    strategyName = (version.content as { name?: string }).name ?? parsed.data.strategy_id;
  }

  const seed =
    parsed.data.question ??
    (strategyName
      ? `Does "${strategyName}" make sense for this plan? Ground the assessment in the client's fact pattern and documents, cite document pages, and list what still needs confirmation.`
      : "Review this plan's fact pattern: what planning opportunities and open questions do you see? Ground observations in the client's documents where possible and cite pages.");

  const [chat] = await db
    .insert(chats)
    .values({
      user_id: req.auth!.user_id,
      title: strategyName ? `Plan: ${plan.title} — ${strategyName}` : `Plan: ${plan.title}`,
      client_id: plan.client_id,
      plan_id: plan.id,
      mode: 'plan',
      strategy_id: parsed.data.strategy_id ?? null,
    })
    .returning();
  await db.insert(messages).values({ chat_id: chat!.id, role: 'user', content: seed });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.chat_launch',
    target_type: 'chat',
    target_id: chat!.id,
    metadata: {
      client_id: plan.client_id,
      plan_id: plan.id,
      strategy_id: parsed.data.strategy_id ?? null,
    },
    ip: req.ip,
  });
  res.status(201).json({ chat_id: chat!.id });
});
