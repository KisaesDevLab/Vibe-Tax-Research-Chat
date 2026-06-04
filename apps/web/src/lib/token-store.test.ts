// Error-path coverage: localStorage can throw (Safari private mode, quota
// exhausted, storage disabled by policy). The token store must degrade
// gracefully rather than crash the auth flow.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { tokenStore } from './token-store';

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

describe('tokenStore localStorage failures', () => {
  it('set() does not throw when setItem throws (quota / disabled)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(() => tokenStore.set('access', 'refresh')).not.toThrow();
  });

  it('getAccess() returns null when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: storage disabled');
    });
    expect(tokenStore.getAccess()).toBeNull();
    expect(tokenStore.getRefresh()).toBeNull();
  });

  it('clear() does not throw when removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => tokenStore.clear()).not.toThrow();
  });

  it('round-trips normally when storage works', () => {
    tokenStore.set('a-token', 'r-token');
    expect(tokenStore.getAccess()).toBe('a-token');
    expect(tokenStore.getRefresh()).toBe('r-token');
    tokenStore.clear();
    expect(tokenStore.getAccess()).toBeNull();
  });
});
