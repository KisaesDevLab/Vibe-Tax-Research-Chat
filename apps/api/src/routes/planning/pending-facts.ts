// TP-8a — the plan-level pending-facts store ("Confirm as fact"). Rows
// accumulate from plan-mode chat; "Promote to client" pushes the pending
// set into a new client_fact_patterns version and stamps each row.
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { plans, plan_pending_facts } from '@vibe/db/schema';
import type { OpenQuestionFact } from '@vibe/shared';
import { validateFactPattern } from '@vibe/schema';
import { audit } from '../../lib/audit.js';
import { applyCandidates } from '../../lib/facts/merge.js';
import {
  createFactPatternVersion,
  currentFactPattern,
  isUniqueViolation,
} from '../../lib/facts/versions.js';
import { FACT_SECTIONS } from '@vibe/shared';
import type { FactCandidate, FactSectionKey } from '@vibe/shared';

export const pendingFactsRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();

async function loadPlan(planId: string) {
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  return plan ?? null;
}

pendingFactsRouter.get('/', async (req, res) => {
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
  const rows = await getDb()
    .select()
    .from(plan_pending_facts)
    .where(and(eq(plan_pending_facts.plan_id, planId), eq(plan_pending_facts.status, 'pending')))
    .orderBy(asc(plan_pending_facts.created_at));
  res.json({ facts: rows });
});

const createSchema = z.object({
  message_id: z.string().uuid().optional(),
  fact_path: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(2000),
  value: z.unknown().optional(),
  source: z
    .object({
      documentId: z.string().uuid(),
      page: z.number().int().min(1),
      span: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    })
    .nullable()
    .optional(),
});

pendingFactsRouter.post('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(planId).success || !parsed.success) {
    res
      .status(400)
      .json({ error: 'bad_request', detail: parsed.success ? undefined : parsed.error.flatten() });
    return;
  }
  const plan = await loadPlan(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [row] = await getDb()
    .insert(plan_pending_facts)
    .values({
      plan_id: planId,
      message_id: parsed.data.message_id ?? null,
      fact_path: parsed.data.fact_path ?? null,
      text: parsed.data.text,
      value: parsed.data.value ?? null,
      source: parsed.data.source ?? null,
      created_by: req.auth!.user_id,
    })
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.fact.confirm',
    target_type: 'plan_pending_fact',
    target_id: row!.id,
    metadata: { client_id: plan.client_id, plan_id: planId, fact_path: row!.fact_path },
    ip: req.ip,
  });
  res.status(201).json({ fact: row });
});

pendingFactsRouter.delete('/:factId', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const factId = req.params.factId ?? '';
  if (!uuidSchema.safeParse(planId).success || !uuidSchema.safeParse(factId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const [row] = await getDb()
    .update(plan_pending_facts)
    .set({ status: 'dismissed' })
    .where(and(eq(plan_pending_facts.id, factId), eq(plan_pending_facts.plan_id, planId)))
    .returning();
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(204).end();
});

// "Promote to client": every pending row becomes part of ONE new client
// fact-pattern version. Pathed rows with a schema-shaped value apply at
// their path; everything else lands as an answered openQuestions entry
// (the statement is preserved verbatim with its document source).
pendingFactsRouter.post('/promote', async (req, res) => {
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
  const rows = await db
    .select()
    .from(plan_pending_facts)
    .where(and(eq(plan_pending_facts.plan_id, planId), eq(plan_pending_facts.status, 'pending')))
    .orderBy(asc(plan_pending_facts.created_at));
  if (rows.length === 0) {
    res.status(409).json({ error: 'nothing_pending' });
    return;
  }

  const sectionOf = (path: string): FactSectionKey | null => {
    const head = path.split('.')[0]?.replace(/\[\]$/, '') ?? '';
    return (FACT_SECTIONS as readonly string[]).includes(head) ? (head as FactSectionKey) : null;
  };

  const accepted: Array<{ candidate: FactCandidate; value: unknown }> = [];
  for (const row of rows) {
    const source = row.source
      ? [
          {
            documentId: row.source.documentId,
            page: row.source.page,
            method: 'chat_confirmed' as const,
          },
        ]
      : [];
    const section = row.fact_path ? sectionOf(row.fact_path) : null;
    if (row.fact_path && section && row.value !== null && row.value !== undefined) {
      accepted.push({
        candidate: {
          id: row.id,
          path: row.fact_path,
          section,
          value: row.value,
          display: row.text,
          sources: source,
          status: 'accepted',
        },
        value: row.value,
      });
    } else {
      const question: OpenQuestionFact = {
        id: row.id,
        question: row.text,
        raisedBy: 'staff',
        status: 'answered',
        sources: source.length ? source : null,
      };
      accepted.push({
        candidate: {
          id: row.id,
          path: 'openQuestions[]',
          section: 'openQuestions',
          value: question,
          display: row.text,
          sources: source,
          status: 'accepted',
        },
        value: question,
      });
    }
  }

  const current = await currentFactPattern(db, plan.client_id);
  const mergedFacts = applyCandidates(current?.facts ?? null, accepted);
  const validated = validateFactPattern(mergedFacts);
  if (!validated.ok) {
    res.status(400).json({ error: 'invalid_facts', detail: validated.errors });
    return;
  }
  try {
    const version = await db.transaction(async (tx) => {
      const v = await createFactPatternVersion(tx, {
        clientId: plan.client_id,
        facts: validated.facts,
        changeSummary: `Promoted ${rows.length} chat-confirmed fact${rows.length === 1 ? '' : 's'} from plan "${plan.title}"`,
        createdBy: req.auth!.user_id,
      });
      for (const row of rows) {
        await tx
          .update(plan_pending_facts)
          .set({ status: 'promoted', promoted_fact_pattern_id: v.id })
          .where(eq(plan_pending_facts.id, row.id));
      }
      return v;
    });
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'plan.facts.promote',
      target_type: 'client_fact_pattern',
      target_id: version.id,
      metadata: {
        client_id: plan.client_id,
        plan_id: planId,
        promoted: rows.length,
        version: version.version,
      },
      ip: req.ip,
    });
    res.json({ fact_pattern: version, promoted: rows.length });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'version_conflict' });
      return;
    }
    throw err;
  }
});
