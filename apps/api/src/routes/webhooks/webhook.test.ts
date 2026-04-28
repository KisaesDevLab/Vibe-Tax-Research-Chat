// Phase 8 — webhook HMAC verification.
//
// Regression test: an earlier version computed the HMAC over
// `JSON.stringify(req.body)` after express.json() had parsed the payload.
// Round-tripping JSON loses byte-identity (whitespace, key order, escape
// shape), which silently rejected legitimate GitHub deliveries. The fix is
// to mount express.raw() on /api/webhooks before express.json() so the
// router HMACs the exact transmitted bytes.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
  process.env.GITHUB_WEBHOOK_SECRET = 'test-secret-webhook';
});

// Stub the queue + audit + logger to avoid touching Redis/DB in unit tests.
vi.mock('../../jobs/queues.js', () => ({
  skillsSyncQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../lib/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function buildApp() {
  const { webhooksRouter } = await import('./index.js');
  const app = express();
  // Mount raw body parser BEFORE the router, mirroring app.ts.
  app.use('/api/webhooks', express.raw({ type: '*/*' }), webhooksRouter);
  return app;
}

describe('GitHub webhook signature verification', () => {
  const secret = 'test-secret-webhook';

  it('accepts a correctly-signed push payload', async () => {
    const app = await buildApp();
    // Note the unusual whitespace + key order — exactly the situation where
    // JSON.stringify(parsed) would have produced different bytes.
    const body = '{"ref":"refs/heads/main",  "after":"abc123"}';
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', sign(body, secret))
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
  });

  it('rejects when the signature is for a different payload', async () => {
    const app = await buildApp();
    const body = '{"ref":"refs/heads/main"}';
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .set('X-Hub-Signature-256', sign('{"ref":"refs/heads/other"}', secret))
      .send(body);
    expect(res.status).toBe(401);
  });

  it('rejects when no signature header is present', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'push')
      .send('{"ref":"refs/heads/main"}');
    expect(res.status).toBe(401);
  });

  it('204s on non-push events even when signature is valid', async () => {
    const app = await buildApp();
    const body = '{"zen":"Speak like a human."}';
    const res = await request(app)
      .post('/api/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'ping')
      .set('X-Hub-Signature-256', sign(body, secret))
      .send(body);
    expect(res.status).toBe(204);
  });
});
