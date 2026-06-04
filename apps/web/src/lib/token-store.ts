// Phase 3 — token storage. localStorage with cross-tab event for logout sync.
//
// Every access is wrapped: localStorage can throw (not just be absent) in
// Safari private mode, when the storage quota is exhausted, or when a
// browser policy disables site data. An uncaught throw here would crash the
// auth flow (token read on every request, token write on login). Reads
// degrade to `null` (treated as logged-out); writes/removes degrade to a
// no-op so the session simply doesn't persist across reloads.
const ACCESS_KEY = 'vibe.access';
const REFRESH_KEY = 'vibe.refresh';

function read(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Quota exceeded / storage disabled — session stays in-memory for this tab.
  }
}

function remove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // Best-effort logout; nothing actionable if the store is unavailable.
  }
}

export const tokenStore = {
  getAccess(): string | null {
    return read(ACCESS_KEY);
  },
  getRefresh(): string | null {
    return read(REFRESH_KEY);
  },
  set(access: string, refresh: string): void {
    write(ACCESS_KEY, access);
    write(REFRESH_KEY, refresh);
  },
  clear(): void {
    remove(ACCESS_KEY);
    remove(REFRESH_KEY);
  },
};
