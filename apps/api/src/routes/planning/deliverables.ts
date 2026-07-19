// TP-9 — deliverable creation/listing/download + signed links. Rules:
// client-facing kinds (client-pdf, handout, pitch-deck, slideshow)
// require the planning.deliverables entitlement (fail-closed) and plan
// ≥ presented; advisor-pdf is internal (fail-open). Local-only clients
// (all clients in this deployment until a Connect identity exists) get
// staff-manual delivery; signed links remain available for firms that
// accept link delivery.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { deliverables, deliverable_links, plans } from '@vibe/db/schema';
import { audit } from '../../lib/audit.js';
import { checkEntitlement } from '../../lib/entitlement.js';
import { mintLinkToken } from '../../lib/signed-links.js';
import { pdfRenderQueue } from '../../jobs/queues.js';
import { deliverableStoragePath } from '../../jobs/handlers/pdf-render.js';
import { buildRenderData } from '../../lib/render/data.js';
import { renderSlideshowHtml } from '../../lib/render/slideshow-html.js';

export const deliverablesRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();
const CLIENT_FACING = new Set(['client-pdf', 'handout', 'pitch-deck', 'slideshow']);
const PRESENTED_PLUS = ['presented', 'engaged', 'delivered'];

const createSchema = z.object({
  kind: z.enum(['advisor-pdf', 'client-pdf', 'handout', 'pitch-deck', 'slideshow']),
  /** handout only: which selected strategy to feature (defaults to the first). */
  strategy_id: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .optional(),
});

deliverablesRouter.post('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = createSchema.safeParse(req.body ?? {});
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
  const kind = parsed.data.kind;
  const clientFacing = CLIENT_FACING.has(kind);
  if (clientFacing) {
    if (!PRESENTED_PLUS.includes(plan.status)) {
      res.status(409).json({ error: 'plan_not_presented' });
      return;
    }
    const ent = await checkEntitlement('planning.deliverables', 'client-facing');
    if (!ent.allowed) {
      res.status(402).json({ error: ent.reason });
      return;
    }
  }
  // Strategy names stay hidden in client-facing artifacts until the plan
  // is engaged; the advisor copy always shows them. (The renderers key
  // teaser-vs-name off this flag for pitch-deck, slideshow, and handout.)
  const reveal = kind === 'advisor-pdf' || ['engaged', 'delivered'].includes(plan.status);
  const [row] = await db
    .insert(deliverables)
    .values({
      plan_id: plan.id,
      kind,
      reveal_strategies: reveal,
      delivered_via: 'staff-manual',
      created_by: req.auth!.user_id,
    })
    .returning();
  await pdfRenderQueue.add('render', {
    deliverable_id: row!.id,
    ...(kind === 'handout' && parsed.data.strategy_id
      ? { handout_strategy_id: parsed.data.strategy_id }
      : {}),
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'deliverable.create',
    target_type: 'deliverable',
    target_id: row!.id,
    metadata: { client_id: plan.client_id, plan_id: plan.id, kind },
    ip: req.ip,
  });
  res.status(201).json({ deliverable: row });
});

deliverablesRouter.get('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const rows = await getDb()
    .select()
    .from(deliverables)
    .where(eq(deliverables.plan_id, planId))
    .orderBy(desc(deliverables.created_at));
  res.json({ deliverables: rows });
});

deliverablesRouter.get('/:deliverableId/download', async (req, res) => {
  const { deliverableId } = req.params as { deliverableId: string };
  if (!uuidSchema.safeParse(deliverableId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const [row] = await getDb()
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, deliverableId))
    .limit(1);
  if (!row || row.status !== 'ready' || !row.storage_ref) {
    res.status(404).json({ error: 'not_ready' });
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${row.kind}-${row.id}.pdf"`);
  res.sendFile(deliverableStoragePath(row.storage_ref));
});

// Staff-facing slideshow web view (renders live HTML, no artifact).
deliverablesRouter.get('/slideshow-view', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    const reveal = ['engaged', 'delivered'].includes(plan.status);
    const data = await buildRenderData(plan.id, reveal);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderSlideshowHtml(data));
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

// ── Signed links ─────────────────────────────────────────────────────────
const linkSchema = z.object({ ttl_days: z.number().int().min(1).max(14).default(14) });

deliverablesRouter.post('/:deliverableId/links', async (req, res) => {
  const { deliverableId } = req.params as { deliverableId: string };
  const parsed = linkSchema.safeParse(req.body ?? {});
  if (!uuidSchema.safeParse(deliverableId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(deliverables)
    .where(eq(deliverables.id, deliverableId))
    .limit(1);
  if (!row || row.status !== 'ready') {
    res.status(404).json({ error: 'not_ready' });
    return;
  }
  if (CLIENT_FACING.has(row.kind)) {
    const ent = await checkEntitlement('planning.deliverables', 'client-facing');
    if (!ent.allowed) {
      res.status(402).json({ error: ent.reason });
      return;
    }
  }
  let minted;
  try {
    minted = mintLinkToken(row.id, parsed.data.ttl_days);
  } catch (err) {
    res.status(503).json({ error: (err as { code?: string }).code ?? 'link_signing_failed' });
    return;
  }
  await db.insert(deliverable_links).values({
    deliverable_id: row.id,
    token_hash: minted.tokenHash,
    expires_at: minted.expiresAt,
    created_by: req.auth!.user_id,
  });
  await db
    .update(deliverables)
    .set({ delivered_via: 'signed-link' })
    .where(eq(deliverables.id, row.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'deliverable.link.create',
    target_type: 'deliverable',
    target_id: row.id,
    metadata: { expires_at: minted.expiresAt.toISOString() },
    ip: req.ip,
  });
  res.status(201).json({
    url: `/api/dl/${minted.token}`,
    expires_at: minted.expiresAt.toISOString(),
  });
});

deliverablesRouter.get('/:deliverableId/links', async (req, res) => {
  const { deliverableId } = req.params as { deliverableId: string };
  if (!uuidSchema.safeParse(deliverableId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const rows = await getDb()
    .select()
    .from(deliverable_links)
    .where(eq(deliverable_links.deliverable_id, deliverableId))
    .orderBy(desc(deliverable_links.created_at));
  res.json({ links: rows });
});

deliverablesRouter.delete('/:deliverableId/links/:linkId', async (req, res) => {
  const { deliverableId, linkId } = req.params as { deliverableId: string; linkId: string };
  if (!uuidSchema.safeParse(deliverableId).success || !uuidSchema.safeParse(linkId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const updated = await getDb()
    .update(deliverable_links)
    .set({ revoked_at: new Date() })
    .where(
      and(eq(deliverable_links.id, linkId), eq(deliverable_links.deliverable_id, deliverableId)),
    )
    .returning({ id: deliverable_links.id });
  if (updated.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'deliverable.link.revoke',
    target_type: 'deliverable',
    target_id: deliverableId,
    metadata: { link_id: linkId },
    ip: req.ip,
  });
  res.status(204).end();
});

// Client Documents tab: every deliverable across the client's plans.
export const clientDeliverablesRouter = Router({ mergeParams: true });
clientDeliverablesRouter.get('/', async (req, res) => {
  const clientId = (req.params as { id?: string }).id ?? '';
  if (!uuidSchema.safeParse(clientId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const db = getDb();
  const planRows = await db
    .select({ id: plans.id, title: plans.title })
    .from(plans)
    .where(eq(plans.client_id, clientId));
  if (planRows.length === 0) {
    res.json({ deliverables: [] });
    return;
  }
  const rows = await db
    .select()
    .from(deliverables)
    .where(
      inArray(
        deliverables.plan_id,
        planRows.map((p) => p.id),
      ),
    )
    .orderBy(desc(deliverables.created_at));
  const planTitle = new Map(planRows.map((p) => [p.id, p.title]));
  res.json({
    deliverables: rows.map((r) => ({ ...r, plan_title: planTitle.get(r.plan_id) ?? '' })),
  });
});
