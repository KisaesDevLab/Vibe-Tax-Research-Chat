// Phase 34 — cfr_lookup tool. Fetches Title 26 (and other titles, on
// request) regulation text from ecfr.gov's versioner JSON API.
//
// Input: { title, part, section? }. The eCFR API is hierarchical; we
// request the smallest scope the caller asked for so cache entries stay
// granular. Cache key encodes the date too — eCFR is dated; we lock the
// cached version to the fetch date so a regression test can reproduce
// what the model saw on a given turn.
import { z } from 'zod';
import { cachedLookup } from '../cache.js';
import { fetchUpstream } from '../http.js';

export const cfrInputSchema = z.object({
  title: z.coerce.number().int().min(1).max(50).default(26),
  part: z.string().min(1).max(64),
  section: z.string().max(64).optional(),
  /**
   * ISO date for the eCFR snapshot to fetch. Defaults to today (UTC).
   * Pin a date to force-pull a specific snapshot for reproducibility.
   */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
});

export type CfrInput = z.infer<typeof cfrInputSchema>;

export interface CfrOutput {
  cite: string;
  url: string;
  text: string;
  fromCache: boolean;
  cacheAgeSeconds: number;
}

export async function cfrLookup(input: CfrInput): Promise<CfrOutput> {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const cite = formatCfrCite(input);
  const cacheKey = `${input.title}-${input.part}${input.section ? `-${input.section}` : ''}@${date}`;

  const cached = await cachedLookup('cfr', cacheKey, async () => {
    const url = cfrUrl(input, date);
    const res = await fetchUpstream(url);
    const parsed = parseEcfrJson(res.text);
    return {
      canonicalUrl: url,
      rawText: res.text,
      parsedText: parsed,
      metadata: { title: input.title, part: input.part, section: input.section, date },
      upstreamStatus: String(res.status),
      upstreamEtag: res.etag,
      upstreamLastModified: res.lastModified,
    };
  });

  return {
    cite,
    url: cached.canonicalUrl,
    text: cached.parsedText,
    fromCache: cached.fromCache,
    cacheAgeSeconds: cached.cacheAgeSeconds,
  };
}

function formatCfrCite(input: CfrInput): string {
  const tail = input.section ? `-${input.section}` : '';
  return `${input.title} CFR § ${input.part}${tail}`;
}

function cfrUrl(input: CfrInput, date: string): string {
  // Versioner API. `?subtitle=...&part=...&section=...` filter only the
  // matching subset of the title.
  const params = new URLSearchParams();
  params.set('part', input.part);
  if (input.section) params.set('section', input.section);
  return `https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${input.title}.json?${params.toString()}`;
}

interface EcfrNode {
  type?: string;
  identifier?: string;
  label?: string;
  label_description?: string;
  text?: string;
  children?: EcfrNode[];
}

interface EcfrResponse {
  // The versioner API wraps the result in a top-level structure that
  // varies by endpoint shape; the section-level full payload is rooted
  // at `content_versions` or `data`/`children`. Be permissive.
  data?: EcfrNode;
  content?: EcfrNode;
  children?: EcfrNode[];
}

// Walk the eCFR tree and emit `IDENT  LABEL\n  TEXT` blocks. Loses some
// formatting but keeps the section/subsection hierarchy intact, which is
// what citation verification needs.
function parseEcfrJson(raw: string): string {
  let payload: EcfrResponse;
  try {
    payload = JSON.parse(raw) as EcfrResponse;
  } catch {
    return raw; // fallback — store raw as parsed if not JSON
  }
  const root: EcfrNode = payload.data ?? payload.content ?? { children: payload.children };
  const out: string[] = [];
  walk(root, out);
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function walk(node: EcfrNode | undefined, out: string[]): void {
  if (!node) return;
  const head = [node.identifier, node.label_description ?? node.label].filter(Boolean).join('  ');
  if (head) out.push(head);
  if (node.text) out.push(node.text);
  if (node.children) for (const c of node.children) walk(c, out);
}
