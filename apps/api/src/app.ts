// Phase 1 — Express app factory. Mounts all routers.
//
// `express-async-errors` is a side-effect import that monkey-patches
// Express 4's Router so async route handlers that throw forward the error
// to the registered error middleware (rather than escaping as an
// unhandledRejection). Express 5 ships this behavior natively; remove this
// import when we upgrade.
import 'express-async-errors';
import express, { type Express, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { env } from './config/env.js';

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { adminUsersRouter } from './routes/admin/users.js';
import { adminSettingsRouter } from './routes/admin/settings.js';
import { adminModelsRouter } from './routes/admin/models.js';
import { adminSkillsRouter } from './routes/admin/skills.js';
import { adminCustomSkillsRouter } from './routes/admin/custom-skills.js';
import { adminUsageRouter } from './routes/admin/usage.js';
import { chatsRouter } from './routes/chats/index.js';
import { webhooksRouter } from './routes/webhooks/index.js';
import { setupRouter } from './routes/setup.js';
import { mountBullBoard } from './routes/admin/bull-board.js';
import { requireAuth, requireRole } from './middleware/auth.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    }),
  );
  app.use(
    cors({
      origin: env.PUBLIC_BASE_URL,
      credentials: true,
    }),
  );
  app.use(compression());
  // Webhooks need the raw body for HMAC verification — mount BEFORE express.json()
  // so the JSON parser doesn't consume + reformat the bytes (GitHub signs the
  // exact request body; round-tripping JSON.parse → JSON.stringify will not
  // reproduce identical bytes).
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '5mb' }), webhooksRouter);

  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  // cookie-parser populates req.cookies. Used by middleware/auth.ts to
  // accept the access token via the `vibe_at` cookie when no Bearer
  // header is present — that's how Bull Board (a server-rendered admin
  // UI mounted at /admin/queues) gets authenticated, since browsers
  // don't attach Authorization headers to plain link clicks.
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.use('/api/health', healthRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/auth', authRouter);
  app.use('/admin/queues', requireAuth, requireRole('admin'), mountBullBoard().getRouter());
  app.use('/api/admin/users', adminUsersRouter);
  app.use('/api/admin/settings', adminSettingsRouter);
  app.use('/api/admin/models', adminModelsRouter);
  app.use('/api/admin/skills', adminSkillsRouter);
  app.use('/api/admin/custom-skills', adminCustomSkillsRouter);
  app.use('/api/admin/usage', adminUsageRouter);
  app.use('/api/chats', chatsRouter);

  // 404
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
  });

  // Error handler — never leak stack traces in prod, never log secrets.
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const status = (err as { status?: number }).status ?? 500;
    logger.error({ err, path: req.path, method: req.method }, 'request failed');
    res.status(status).json({
      error: status === 500 ? 'internal_error' : (err.message ?? 'error'),
      ...(env.NODE_ENV === 'development' && status === 500 ? { detail: String(err) } : {}),
    });
  };
  app.use(errorHandler);

  return app;
}
