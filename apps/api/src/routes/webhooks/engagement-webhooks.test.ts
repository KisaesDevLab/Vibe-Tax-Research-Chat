// TP-10 — signed-fixture tests for the OpenSign + Stripe webhooks:
// happy path, bad signature, replay idempotency, stale timestamp,
// unknown-event-type no-op (QA round 1).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const applyEngagementUpdate = vi.fn(async () => ({ engaged: false, replay: false }));

vi.mock('../../lib/engagement/index.js', () => ({
  applyEngagementUpdate: (...args: unknown[]) => applyEngagementUpdate(...(args as [])),
}));
vi.mock('../../jobs/queues.js', () => ({ skillsSyncQueue: { add: vi.fn() } }));
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const OPENSIGN_SECRET = 'opensign-test-secret';
const STRIPE_SECRET = 'whsec_test_secret';

async function buildApp() {
  const { webhooksRouter } = await import('./index.js');
  const app = express();
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '5mb' }), webhooksRouter);
  return app;
}

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL = 'postgres://x:x@localhost:9/x';
  process.env.REDIS_URL = 'redis://localhost:9';
  process.env.OPENSIGN_WEBHOOK_SECRET = OPENSIGN_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
});

describe('POST /api/webhooks/opensign', () => {
  const payload = JSON.stringify({
    event_id: 'evt_1',
    type: 'document.signed',
    plan_id: 'a4b1c1d1-0000-0000-0000-000000000001',
    envelope_id: 'env_9',
  });
  const sign = (body: string, secret = OPENSIGN_SECRET) =>
    crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature and applies the update atomically with dedupe', async () => {
    applyEngagementUpdate.mockClear();
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/opensign')
      .set('X-OpenSign-Signature', sign(payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(applyEngagementUpdate).toHaveBeenCalledWith(
      'a4b1c1d1-0000-0000-0000-000000000001',
      expect.objectContaining({ letter_status: 'signed' }),
      null,
      { provider: 'opensign', externalEventId: 'evt_1' },
    );
  });

  it('rejects a bad signature', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/opensign')
      .set('X-OpenSign-Signature', sign(payload, 'wrong'))
      .send(payload);
    expect(res.status).toBe(401);
  });

  it('replayed event ids are acknowledged but not re-applied', async () => {
    applyEngagementUpdate.mockResolvedValueOnce({ engaged: false, replay: true });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/opensign')
      .set('X-OpenSign-Signature', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.replay).toBe(true);
  });

  it('unknown event types are acknowledged without touching state', async () => {
    applyEngagementUpdate.mockClear();
    const viewed = JSON.stringify({
      event_id: 'evt_viewed',
      type: 'document.viewed',
      plan_id: 'a4b1c1d1-0000-0000-0000-000000000001',
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/opensign')
      .set('X-OpenSign-Signature', sign(viewed))
      .send(viewed);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(applyEngagementUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/stripe', () => {
  const payload = JSON.stringify({
    id: 'evt_stripe_1',
    type: 'invoice.paid',
    data: {
      object: { id: 'in_123', metadata: { plan_id: 'a4b1c1d1-0000-0000-0000-000000000002' } },
    },
  });
  const sigHeader = (body: string, ts = Math.floor(Date.now() / 1000), secret = STRIPE_SECRET) => {
    const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return `t=${ts},v1=${v1}`;
  };

  it('accepts a valid t=/v1= signature', async () => {
    applyEngagementUpdate.mockClear();
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sigHeader(payload))
      .send(payload);
    expect(res.status).toBe(200);
    expect(applyEngagementUpdate).toHaveBeenCalledWith(
      'a4b1c1d1-0000-0000-0000-000000000002',
      expect.objectContaining({ payment_status: 'paid' }),
      null,
      { provider: 'stripe', externalEventId: 'evt_stripe_1' },
    );
  });

  it('rejects a stale timestamp', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sigHeader(payload, Math.floor(Date.now() / 1000) - 3600))
      .send(payload);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('timestamp_out_of_tolerance');
  });

  it('rejects a tampered body', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sigHeader(payload))
      .send(payload.replace('invoice.paid', 'invoice.payment_failed'));
    expect(res.status).toBe(401);
  });

  it('replay is a no-op', async () => {
    applyEngagementUpdate.mockResolvedValueOnce({ engaged: false, replay: true });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sigHeader(payload))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.replay).toBe(true);
  });

  it('out-of-order benign events (invoice.finalized) never downgrade state', async () => {
    applyEngagementUpdate.mockClear();
    const finalized = JSON.stringify({
      id: 'evt_stripe_2',
      type: 'invoice.finalized',
      data: {
        object: { id: 'in_123', metadata: { plan_id: 'a4b1c1d1-0000-0000-0000-000000000002' } },
      },
    });
    const app = await buildApp();
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', sigHeader(finalized))
      .send(finalized);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(applyEngagementUpdate).not.toHaveBeenCalled();
  });
});
