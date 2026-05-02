// Phase 34 — shared upstream fetch helper for authority sources.
//
// Wraps fetch() with a timeout, the configured User-Agent, and
// HTML→text stripping for sources that only expose XHTML. Federal
// endpoints rate-limit + bot-filter aggressively, so we surface a
// distinct error class that the cache layer logs without poisoning
// the cache.
import { env } from './config.js';

export class UpstreamFetchError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    public readonly bodySnippet: string,
  ) {
    super(`upstream fetch failed: ${url} → HTTP ${status}: ${bodySnippet.slice(0, 120)}`);
    this.name = 'UpstreamFetchError';
  }
}

export async function fetchUpstream(
  url: string,
  init: RequestInit = {},
): Promise<{ text: string; status: number; etag?: string; lastModified?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AUTHORITY_FETCH_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has('User-Agent')) headers.set('User-Agent', env.AUTHORITY_FETCH_UA);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/xml,application/json,text/html,*/*;q=0.5');
    }
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new UpstreamFetchError(url, res.status, text);
    }
    return {
      text,
      status: res.status,
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Cheap HTML→text. Strips tags, decodes the common entities, collapses
// runs of whitespace. Good enough for federal source pages where the
// useful payload is the inner-text of a body element. Don't use this on
// arbitrary user-uploaded HTML — it doesn't parse and is not security-
// hardened (we trust the upstream).
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
