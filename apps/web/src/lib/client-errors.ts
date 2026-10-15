// Sends render failures to POST /api/client-errors so they land in
// Admin → Client errors instead of dying in one person's DevTools console.
// Best effort by design: a report that fails is dropped, never retried, and
// never surfaces to the user.
import { api, SPA_BASE_PATH } from './api';
import { tokenStore } from './token-store';

export interface ClientErrorReport {
  kind: 'panel' | 'app' | 'window';
  source?: string;
  error: unknown;
  componentStack?: string | null;
  chatId?: string | null;
  messageId?: string | null;
}

// A page that re-renders a broken panel would otherwise report on every pass.
const MAX_REPORTS_PER_PAGE = 20;
const sent = new Set<string>();

const CHAT_ROUTE_RE = /\/research\/([0-9a-f-]{36})(?:[/?#]|$)/i;

/** The current route without the SPA prefix — what an admin would type after the host. */
function currentRoute(): string {
  const path = window.location.pathname;
  return SPA_BASE_PATH && path.startsWith(SPA_BASE_PATH)
    ? path.slice(SPA_BASE_PATH.length) || '/'
    : path;
}

export function reportClientError(r: ClientErrorReport): void {
  // Signed-out pages have nowhere to report to, and skipRefresh below keeps
  // a stale token from triggering a refresh (or a sign-out) from here.
  if (!tokenStore.getAccess()) return;

  const err = r.error instanceof Error ? r.error : null;
  const message = (err ? `${err.name}: ${err.message}` : String(r.error)) || 'Unknown error';
  const route = currentRoute();
  const chatId = r.chatId ?? route.match(CHAT_ROUTE_RE)?.[1] ?? null;

  const key = [r.kind, r.source, message, r.messageId ?? chatId ?? route].join('|');
  if (sent.has(key) || sent.size >= MAX_REPORTS_PER_PAGE) return;
  sent.add(key);

  void api('/api/client-errors', {
    method: 'POST',
    skipRefresh: true,
    body: JSON.stringify({
      kind: r.kind,
      source: r.source ?? null,
      message,
      stack: err?.stack ?? null,
      component_stack: r.componentStack ?? null,
      route,
      chat_id: chatId,
      message_id: r.messageId ?? null,
    }),
  }).catch(() => undefined);
}

/**
 * Uncaught errors outside React's render (event handlers, timers). Only
 * errors thrown from this app's own scripts — browser extensions and
 * cross-origin scripts are noise an admin cannot act on.
 */
export function installWindowErrorReporting(): void {
  window.addEventListener('error', (e) => {
    if (!e.filename || new URL(e.filename, window.location.href).origin !== window.location.origin)
      return;
    reportClientError({ kind: 'window', error: e.error ?? e.message });
  });
}
