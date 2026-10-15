// Browser error reporting. Any signed-in user's SPA posts here when an error
// boundary catches a render failure; admins read and clear the log under
// /api/admin/client-errors (Admin → Client errors).
import { Router } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { client_errors, users } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { clientErrorLimiter } from '../lib/rate-limit.js';
import { clientErrorSchema, recordClientError } from '../lib/client-errors.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

export const clientErrorsRouter = Router();

clientErrorsRouter.post('/', clientErrorLimiter, requireAuth, async (req, res) => {
  const parsed = clientErrorSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const report = parsed.data;
  // Also into the api log, so it shows up next to server-side context.
  logger.warn(
    {
      client_error: {
        kind: report.kind,
        source: report.source,
        message: report.message,
        route: report.route,
        chat_id: report.chat_id,
        message_id: report.message_id,
      },
      user_id: req.auth!.user_id,
    },
    'client render error reported',
  );
  try {
    await recordClientError(report, {
      user_id: req.auth!.user_id,
      user_agent: req.get('user-agent') ?? null,
      app_version: process.env.APP_VERSION ?? 'dev',
    });
  } catch (err) {
    // Reporting must never become a second failure for the browser.
    logger.error({ err }, 'client error report could not be stored');
  }
  res.status(204).end();
});

export const adminClientErrorsRouter = Router();
adminClientErrorsRouter.use(requireAuth, requireRole('admin'));

adminClientErrorsRouter.get('/', async (_req, res) => {
  const rows = await getDb()
    .select({
      id: client_errors.id,
      kind: client_errors.kind,
      source: client_errors.source,
      message: client_errors.message,
      stack: client_errors.stack,
      component_stack: client_errors.component_stack,
      route: client_errors.route,
      chat_id: client_errors.chat_id,
      message_id: client_errors.message_id,
      app_version: client_errors.app_version,
      user_agent: client_errors.user_agent,
      user_email: users.email,
      count: client_errors.count,
      first_seen_at: client_errors.first_seen_at,
      last_seen_at: client_errors.last_seen_at,
    })
    .from(client_errors)
    .leftJoin(users, eq(users.id, client_errors.user_id))
    .orderBy(desc(client_errors.last_seen_at))
    .limit(500);
  res.json({ errors: rows });
});

adminClientErrorsRouter.delete('/:id', async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const deleted = await getDb()
    .delete(client_errors)
    .where(eq(client_errors.id, req.params.id!))
    .returning({ id: client_errors.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.client_errors.delete',
    target_type: 'client_error',
    target_id: req.params.id,
    ip: req.ip,
  });
  res.status(204).end();
});

adminClientErrorsRouter.delete('/', async (req, res) => {
  const deleted = await getDb().delete(client_errors).returning({ id: client_errors.id });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.client_errors.clear',
    target_type: 'client_error',
    metadata: { deleted: deleted.length },
    ip: req.ip,
  });
  res.status(204).end();
});
