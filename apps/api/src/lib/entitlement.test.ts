import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkEntitlement, clearEntitlementCache } from './entitlement.js';

describe('checkEntitlement', () => {
  const OLD = { url: process.env.LICENSING_URL, key: process.env.LICENSE_KEY };
  beforeEach(() => clearEntitlementCache());
  afterEach(() => {
    process.env.LICENSING_URL = OLD.url ?? '';
    process.env.LICENSE_KEY = OLD.key ?? '';
    if (!OLD.url) delete process.env.LICENSING_URL;
    if (!OLD.key) delete process.env.LICENSE_KEY;
    vi.restoreAllMocks();
  });

  it('unconfigured: internal fail-open, client-facing fail-closed', async () => {
    delete process.env.LICENSING_URL;
    delete process.env.LICENSE_KEY;
    expect((await checkEntitlement('planning.deliverables', 'internal')).allowed).toBe(true);
    const cf = await checkEntitlement('planning.deliverables', 'client-facing');
    expect(cf.allowed).toBe(false);
    expect(cf.reason).toBe('license_required');
  });

  it('granted entitlement allows both directions', async () => {
    process.env.LICENSING_URL = 'https://licensing.example';
    process.env.LICENSE_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ granted: true }) })),
    );
    expect((await checkEntitlement('planning.deliverables', 'client-facing')).allowed).toBe(true);
    expect((await checkEntitlement('planning.deliverables', 'internal')).allowed).toBe(true);
  });

  it('denied entitlement: internal open, client-facing closed', async () => {
    process.env.LICENSING_URL = 'https://licensing.example';
    process.env.LICENSE_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ granted: false }) })),
    );
    expect((await checkEntitlement('planning.deliverables', 'internal')).allowed).toBe(true);
    expect((await checkEntitlement('planning.deliverables', 'client-facing')).allowed).toBe(false);
  });

  it('network failure follows the same split', async () => {
    process.env.LICENSING_URL = 'https://licensing.example';
    process.env.LICENSE_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect((await checkEntitlement('planning.deliverables', 'internal')).allowed).toBe(true);
    const cf = await checkEntitlement('planning.deliverables', 'client-facing');
    expect(cf.allowed).toBe(false);
    expect(cf.reason).toContain('fail_closed');
  });
});
