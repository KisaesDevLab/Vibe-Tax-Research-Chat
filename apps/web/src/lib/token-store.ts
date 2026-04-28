// Phase 3 — token storage. localStorage with cross-tab event for logout sync.
const ACCESS_KEY = 'vibe.access';
const REFRESH_KEY = 'vibe.refresh';

export const tokenStore = {
  getAccess(): string | null {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null;
  },
  getRefresh(): string | null {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
  },
  set(access: string, refresh: string): void {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};
