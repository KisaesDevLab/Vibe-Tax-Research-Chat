// QA round 2 — review-queue decision surface.
//
// Finding 1: approving a strategy draft must demote the outgoing
// published version inside the same transaction — the schema has no
// single-published constraint, so the demote is the only thing keeping
// (strategy_id, status='published') unique.
// Finding 4: every review_queue kind is a planning-pipeline artifact and
// the table-draft approve branch publishes a table set, so the router
// sits behind requirePlanning (404 when the module is off, matching the
// standalone table-sets publish endpoint).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { review_queue, strategies, strategy_versions } from '@vibe/db/schema';

const planningEnabled = vi.fn(async (): Promise<unknown> => true);
vi.mock('../../lib/settings-store.js', () => ({
  getSetting: () => planningEnabled(),
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { user_id: 'admin-1' };
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../jobs/queues.js', () => ({
  goldenRegressionQueue: { add: vi.fn(async () => ({ id: 'job-1' })) },
  strategyAuthorQueue: { add: vi.fn(async () => ({ id: 'job-2' })) },
  strategyRefreshQueue: { add: vi.fn(async () => ({ id: 'job-3' })) },
}));
vi.mock('@vibe/strategies', () => ({ listModuleRefs: () => [] }));

type Row = Record<string, unknown>;
interface UpdateCall {
  table: unknown;
  set: Row;
}
const state: { item: Row | null; version: Row | null; updates: UpdateCall[] } = {
  item: null,
  version: null,
  updates: [],
};

function rowsFor(table: unknown): Row[] {
  if (table === review_queue) return state.item ? [state.item] : [];
  if (table === strategy_versions) return state.version ? [state.version] : [];
  return [];
}

// Minimal drizzle-shaped fake: selects resolve canned rows per table,
// updates are recorded (with their SET values) for assertions.
function makeExecutor(): Record<string, unknown> {
  return {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        return {
          where: () => ({
            limit: async () => rows,
            orderBy: () => ({ limit: async () => rows }),
          }),
          orderBy: () => ({ limit: async () => rows }),
          limit: async () => rows,
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          state.updates.push({ table, set: values });
          const result = Promise.resolve([{ id: 'updated' }]) as Promise<Array<{ id: string }>> & {
            returning: () => Promise<Array<{ id: string }>>;
          };
          result.returning = async () => [{ id: 'updated' }];
          return result;
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeExecutor()),
  };
}

vi.mock('@vibe/db', () => ({ getDb: () => makeExecutor() }));

async function buildApp() {
  const { adminReviewQueueRouter } = await import('./review-queue.js');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/review-queue', adminReviewQueueRouter);
  return app;
}

const ITEM_ID = '5f0f8a2e-0000-4000-8000-000000000001';
const VERSION_ID = '5f0f8a2e-0000-4000-8000-000000000002';
const STRATEGY_ID = 'qbi-optimization';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL = 'postgres://x:x@localhost:9/x';
  process.env.REDIS_URL = 'redis://localhost:9';
});

beforeEach(() => {
  planningEnabled.mockImplementation(async () => true);
  state.updates = [];
  state.item = {
    id: ITEM_ID,
    kind: 'strategy-draft',
    status: 'open',
    payload: {
      strategy_id: STRATEGY_ID,
      version_id: VERSION_ID,
      validation: { ok: true, errors: [] },
    },
  };
  state.version = { id: VERSION_ID, status: 'draft', apply_module_ref: null };
});

describe('POST /api/admin/review-queue/:id/approve (strategy-draft)', () => {
  it('demotes the outgoing published version before publishing the new one', async () => {
    const app = await buildApp();
    const res = await request(app).post(`/api/admin/review-queue/${ITEM_ID}/approve`).send({});
    expect(res.status).toBe(200);

    const versionUpdates = state.updates.filter((u) => u.table === strategy_versions);
    const demoteIdx = versionUpdates.findIndex((u) => u.set.status === 'deprecated');
    const publishIdx = versionUpdates.findIndex((u) => u.set.status === 'published');
    expect(demoteIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThanOrEqual(0);
    expect(demoteIdx).toBeLessThan(publishIdx);
    // current_version_id still bumps to the newly published version.
    const strategyUpdate = state.updates.find((u) => u.table === strategies);
    expect(strategyUpdate?.set.current_version_id).toBe(VERSION_ID);
  });
});

describe('planning flag gate', () => {
  it('404s review-queue decisions when planning is disabled', async () => {
    planningEnabled.mockImplementation(async () => false);
    const app = await buildApp();
    const res = await request(app).post(`/api/admin/review-queue/${ITEM_ID}/approve`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
    expect(state.updates).toHaveLength(0);
  });
});
