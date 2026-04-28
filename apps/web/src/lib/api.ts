// Phase 3 — small fetch wrapper with auth header + refresh-on-401.
import { tokenStore } from './token-store';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(
      typeof body === 'object' && body && 'error' in body
        ? String((body as Record<string, unknown>).error)
        : `HTTP ${status}`,
    );
  }
}

// Runtime base URL — derived from import.meta.env.BASE_URL, which Vite
// fills from the runtime sentinel substituted by the web container's
// docker-entrypoint hook. Single-app boots BASE_URL=`/`, multi-app
// boots BASE_URL=`/tax/`, so a `/api/...` path becomes `/api/...` or
// `/tax/api/...` without a rebuild. Same pattern as
// Vibe-Payroll-Time/frontend/src/lib/api.ts — keep in sync.
//
// Exported because useChatStream.ts and any future direct-fetch
// callers must use it too; never write a raw `fetch('/api/...')`
// in this codebase.
export function apiUrl(path: string): string {
  // Absolute URLs pass through untouched (e.g. preconnect probes).
  if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) return path;
  // BASE_URL always ends with a slash. Strip the leading slash on the
  // path to avoid `//api/...` when BASE_URL is `/`.
  const base = import.meta.env.BASE_URL;
  return `${base}${path.replace(/^\//, '')}`;
}

async function refreshOnce(): Promise<boolean> {
  const refresh_token = tokenStore.getRefresh();
  if (!refresh_token) return false;
  try {
    const r = await fetch(apiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });
    if (!r.ok) return false;
    const json = (await r.json()) as { access_token: string; refresh_token: string };
    tokenStore.set(json.access_token, json.refresh_token);
    return true;
  } catch {
    return false;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit & { skipRefresh?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  const access = tokenStore.getAccess();
  if (access) headers.set('authorization', `Bearer ${access}`);

  const res = await fetch(apiUrl(path), { ...init, headers });
  if (res.status === 401 && !init.skipRefresh) {
    if (await refreshOnce()) {
      return api<T>(path, { ...init, skipRefresh: true });
    }
    tokenStore.clear();
  }
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
