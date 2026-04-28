// Phase 24 — usage analytics.
import { Router } from 'express';
import { z } from 'zod';
import { and, gte, lte, eq, desc, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { usage_events, usage_daily, users } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';

export const adminUsageRouter = Router();
adminUsageRouter.use(requireAuth, requireRole('admin'));

const filterSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  user_id: z.string().uuid().optional(),
  model_id: z.string().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

adminUsageRouter.get('/', async (req, res) => {
  const parsed = filterSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { from, to, user_id, model_id, format } = parsed.data;
  const conditions = [];
  if (from) conditions.push(gte(usage_events.occurred_at, new Date(from)));
  if (to) conditions.push(lte(usage_events.occurred_at, new Date(to)));
  if (user_id) conditions.push(eq(usage_events.user_id, user_id));
  if (model_id) conditions.push(eq(usage_events.model_id, model_id));

  // LEFT JOIN against users so the SPA + CSV export both carry an email
  // for the actor. usage_events.user_id is non-nullable, but the join is
  // still LEFT in case a user got hard-deleted (soft delete is the norm —
  // see admin/users.ts — but a hard prod cleanup shouldn't hide history).
  const rows = await getDb()
    .select({
      occurred_at: usage_events.occurred_at,
      user_id: usage_events.user_id,
      user_email: users.email,
      user_display_name: users.display_name,
      chat_id: usage_events.chat_id,
      message_id: usage_events.message_id,
      model_id: usage_events.model_id,
      input_tokens: usage_events.input_tokens,
      output_tokens: usage_events.output_tokens,
      cache_creation_input_tokens: usage_events.cache_creation_input_tokens,
      cache_read_input_tokens: usage_events.cache_read_input_tokens,
      web_fetch_calls: usage_events.web_fetch_calls,
      web_search_calls: usage_events.web_search_calls,
      cost_usd: usage_events.cost_usd,
    })
    .from(usage_events)
    .leftJoin(users, eq(users.id, usage_events.user_id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(usage_events.occurred_at))
    .limit(5000);

  if (format === 'csv') {
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="usage.csv"');
    // Quote the email so unusual addresses don't break column alignment;
    // double any embedded quote per RFC 4180.
    const csvField = (s: string | null | undefined): string => {
      const v = (s ?? '').toString();
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const header =
      'occurred_at,user_id,user_email,chat_id,model_id,input,output,cache_w,cache_r,fetches,searches,est_cost_usd\n';
    const lines = rows.map(
      (r) =>
        `${r.occurred_at.toISOString()},${r.user_id},${csvField(r.user_email)},${r.chat_id},${r.model_id},${r.input_tokens},${r.output_tokens},${r.cache_creation_input_tokens},${r.cache_read_input_tokens},${r.web_fetch_calls},${r.web_search_calls},${r.cost_usd}`,
    );
    res.send(header + lines.join('\n'));
    return;
  }
  res.json({ events: rows });
});

adminUsageRouter.get('/daily', async (_req, res) => {
  const rows = await getDb().select().from(usage_daily).orderBy(desc(usage_daily.day)).limit(180);
  res.json({ daily: rows });
});

adminUsageRouter.get('/totals', async (_req, res) => {
  const totals = await getDb()
    .select({
      model_id: usage_events.model_id,
      messages: sql<number>`count(*)`.as('messages'),
      total_cost: sql<number>`sum(${usage_events.cost_usd})`.as('total_cost'),
    })
    .from(usage_events)
    .groupBy(usage_events.model_id);
  res.json({ totals });
});
