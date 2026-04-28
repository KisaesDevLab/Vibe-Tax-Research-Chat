// Phase 1 + 25 — entrypoint. Starts Express + BullMQ workers.
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './jobs/workers.js';

// Last-line-of-defense: any promise that escapes our handlers should be
// logged, not abort the process. BullMQ workers + their per-queue 'error'
// listeners are the primary defense; this is the safety net for everything
// else (a stray .then() with no .catch, library-internal escapes, etc.).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection (caught)');
});
process.on('uncaughtException', (err) => {
  // uncaughtException after this point can leave the process in a corrupt
  // state — log loudly, then re-throw so the supervisor (docker
  // restart=unless-stopped) can decide whether to recycle.
  logger.fatal({ err }, 'uncaughtException — exiting');
  process.exit(1);
});

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
});

if (process.env.WORKERS_ENABLED !== 'false') {
  startWorkers();
  logger.info('background workers started');
}

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
