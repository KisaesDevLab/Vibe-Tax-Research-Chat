// Phase 34 — fetchUpstream + stripHtmlToText.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://x/x';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stripHtmlToText', () => {
  it('removes script and style blocks', async () => {
    const { stripHtmlToText } = await import('./http.js');
    const html = '<script>alert(1)</script><style>p { color: red }</style><p>hello world</p>';
    expect(stripHtmlToText(html)).toBe('hello world');
  });

  it('decodes &amp;, &lt;, &gt;, numeric entities', async () => {
    const { stripHtmlToText } = await import('./http.js');
    expect(stripHtmlToText('A &amp; B &#38; C')).toBe('A & B & C');
    expect(stripHtmlToText('&lt;tag&gt;')).toBe('<tag>');
  });

  it('collapses whitespace and preserves paragraph breaks', async () => {
    const { stripHtmlToText } = await import('./http.js');
    const html = '<p>Para one.</p>\n\n\n<p>Para two.</p>';
    const out = stripHtmlToText(html);
    expect(out).toContain('Para one.');
    expect(out).toContain('Para two.');
    // Double newline between paragraphs preserved
    expect(out).toMatch(/Para one\.\s*\n\n\s*Para two\./);
  });
});

describe('fetchUpstream', () => {
  it('throws UpstreamFetchError on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const { fetchUpstream, UpstreamFetchError } = await import('./http.js');
    await expect(fetchUpstream('https://example.com/x')).rejects.toBeInstanceOf(UpstreamFetchError);
  });

  it('attaches the configured User-Agent', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('ok', { status: 200 });
      }),
    );
    const { fetchUpstream } = await import('./http.js');
    await fetchUpstream('https://example.com/x');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('User-Agent')).toContain('VibeTaxResearchAuthorityCache');
  });
});
