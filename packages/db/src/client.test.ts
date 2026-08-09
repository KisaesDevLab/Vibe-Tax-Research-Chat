// DR v2 — pool lifecycle. The singletons must reset synchronously so a
// caller racing closeDb() against a timeout can never be handed back a
// half-ended pool from a later getDb().
import { describe, expect, it, vi, beforeEach } from 'vitest';

const endMock = vi.fn();
vi.mock('postgres', () => ({
  default: vi.fn(() => ({ end: endMock })),
}));
vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn((pool: unknown) => ({ _pool: pool })),
}));

async function freshModule() {
  vi.resetModules();
  return import('./index.js');
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/test';
  endMock.mockReset();
});

describe('db client lifecycle', () => {
  it('closeDb resets singletons before awaiting the drain', async () => {
    const { getDb, closeDb } = await freshModule();
    const first = getDb();

    // A drain that never resolves — the old failure mode.
    let release!: () => void;
    endMock.mockReturnValue(new Promise<void>((r) => (release = r)));
    const closing = closeDb();

    // Even with the drain pending, the next getDb() must build a NEW pool.
    const second = getDb();
    expect(second).not.toBe(first);

    release();
    await closing;
  });

  it('resetDb forces a fresh pool synchronously and swallows drain errors', async () => {
    const { getDb, resetDb } = await freshModule();
    const first = getDb();
    endMock.mockReturnValue(Promise.reject(new Error('wedged')));
    resetDb();
    const second = getDb();
    expect(second).not.toBe(first);
    // Let the rejected drain settle; resetDb attached the catch.
    await new Promise((r) => setImmediate(r));
  });
});
