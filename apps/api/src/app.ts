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
import { pingRouter } from './routes/ping.js';
import { authRouter } from './routes/auth.js';
import { adminUsersRouter } from './routes/admin/users.js';
import { adminSettingsRouter } from './routes/admin/settings.js';
import { adminModelsRouter } from './routes/admin/models.js';
import { adminSkillsRouter } from './routes/admin/skills.js';
import { adminCustomSkillsRouter } from './routes/admin/custom-skills.js';
import { adminReferencesRouter } from './routes/admin/references.js';
import { adminUsageRouter } from './routes/admin/usage.js';
import { chatsRouter } from './routes/chats/index.js';
import { configRouter } from './routes/config.js';
import { clientsRouter } from './routes/clients/index.js';
import { archivesRouter } from './routes/archives.js';
import { webhooksRouter } from './routes/webhooks/index.js';
import { setupRouter } from './routes/setup.js';
import { mountBullBoard } from './routes/admin/bull-board.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { corsOptions } from './lib/cors.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Trust the immediate reverse proxy (Caddy / appliance Caddy / HAProxy
  // emergency-proxy / nginx). Without this, X-Forwarded-Proto is ignored,
  // req.secure stays false on TLS connections, and the Secure-cookie
  // policy in lib/cookies.ts can't tell HTTPS apart from HTTP.
  app.set('trust proxy', env.TRUST_PROXY);
  app.use(
    helmet({
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    }),
  );
  app.use(cors(corsOptions()));
  // compression() must NOT compress text/event-stream — it buffers writes
  // and the browser sees deltas in big batches instead of as they arrive,
  // which makes a streaming chat turn look frozen for tens of seconds at
  // a time. Skip SSE; let everything else compress normally.
  app.use(
    compression({
      filter: (req, res) => {
        const ct = res.getHeader('Content-Type');
        if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
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
  app.use('/api/ping', pingRouter);
  app.use('/api/setup', setupRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/config', configRouter);
  app.use('/admin/queues', requireAuth, requireRole('admin'), mountBullBoard().getRouter());
  app.use('/api/admin/users', adminUsersRouter);
  app.use('/api/admin/settings', adminSettingsRouter);
  app.use('/api/admin/models', adminModelsRouter);
  app.use('/api/admin/skills', adminSkillsRouter);
  app.use('/api/admin/custom-skills', adminCustomSkillsRouter);
  app.use('/api/admin/references', adminReferencesRouter);
  app.use('/api/admin/usage', adminUsageRouter);
  app.use('/api/chats', chatsRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/archives', archivesRouter);

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
