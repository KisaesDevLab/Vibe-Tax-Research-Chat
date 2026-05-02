// Appliance packaging — /api/ping must return 200 with no DB or Redis
// dependency. Used by the appliance bootstrapper and the HAProxy emergency
// frontend on :5191 to gauge process liveness even when downstream
// dependencies are themselves degraded.
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
});

describe('/api/ping', () => {
  it('returns 200 { ok: true } without touching DB or Redis', async () => {
    const { pingRouter } = await import('./ping.js');
    const app = express();
    app.use('/api/ping', pingRouter);
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('also handles HEAD for liveness probes', async () => {
    const { pingRouter } = await import('./ping.js');
    const app = express();
    app.use('/api/ping', pingRouter);
    const res = await request(app).head('/api/ping');
    expect(res.status).toBe(200);
  });
});
