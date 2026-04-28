// Phase 1 — health endpoints. /api/health is cheap; /api/health/deep pings db + redis.
import { Router } from 'express';
import { getDb } from '@vibe/db';
import { sql } from 'drizzle-orm';
import { pingRedis } from '../lib/redis.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

healthRouter.get('/deep', async (_req, res) => {
  const checks: Record<string, { ok: boolean; latency_ms?: number; error?: string }> = {};

  // DB check
  const dbStart = Date.now();
  try {
    await getDb().execute(sql`SELECT 1`);
    checks.db = { ok: true, latency_ms: Date.now() - dbStart };
  } catch (err) {
    checks.db = { ok: false, error: (err as Error).message };
  }

  // Redis check
  const redisStart = Date.now();
  try {
    const ok = await pingRedis();
    checks.redis = { ok, latency_ms: Date.now() - redisStart };
  } catch (err) {
    checks.redis = { ok: false, error: (err as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks });
});
