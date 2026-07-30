// Phase 1 + 25 — entrypoint. Starts Express + BullMQ workers.
import { runMigrations, runSeed, pendingMigrationCount } from '@vibe/db';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './jobs/workers.js';
import { recoverOrphanedStreams } from './lib/stream-recovery.js';

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

async function start(): Promise<void> {
  // Auto-migrate before binding the listener. Default off so the standalone
  // install flow stays "operator runs db:migrate:prod explicitly"; the
  // appliance manifest sets MIGRATIONS_AUTO=true so the bootstrapper doesn't
  // need a separate exec step. Failures here are fatal — a partially-migrated
  // DB serving traffic is worse than refusing to start.
  //
  // Seed runs in the same gate: migrations create the empty `models` table,
  // and without the seed the first-run wizard's default-model step always
  // 400s with `unknown_or_inactive_model` (no rows match). The seed is
  // idempotent (`onConflictDoNothing`) so admin-customized rows are
  // preserved and re-runs are no-ops.
  if (env.MIGRATIONS_AUTO) {
    logger.info('MIGRATIONS_AUTO=true — running migrations before listen');
    await runMigrations();
    logger.info('migrations complete');
    await runSeed();
    logger.info('seed complete');
  } else {
    // Not auto-migrating is a legitimate choice, but a schema behind the
    // image breaks features in ways that surface far from the cause (an
    // un-applied 0015 made every deliverable render fail with `relation
    // "plan_memos" does not exist`). Say so at startup, once, loudly.
    const state = await pendingMigrationCount().catch(() => null);
    if (state && state.pending > 0) {
      logger.error(
        { shipped: state.shipped, applied: state.applied, pending: state.pending },
        `DATABASE SCHEMA IS BEHIND THIS BUILD — ${state.pending} migration(s) not applied. ` +
          'Run `pnpm db:migrate:prod` (or set MIGRATIONS_AUTO=true) before using the app; ' +
          'features touching new tables will fail until you do.',
      );
    }
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  if (process.env.WORKERS_ENABLED !== 'false') {
    startWorkers();
    logger.info('background workers started');
  }

  // Recover any chat threads whose last assistant turn was severed by the
  // previous process dying mid-stream. We can't catch that case from inside
  // the SSE handler (req.on('close') doesn't fire when the SERVER goes
  // away), so we sweep on startup instead and write a system_note into
  // each affected chat. Runs async; never blocks listening.
  void recoverOrphanedStreams();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
