// Phase 34 — usc_lookup tool. Fetches USC Title 26 sections from
// uscode.house.gov.
//
// Input: { title, section, subsection? }. Default title is 26 since this
// is a tax-research appliance, but the contract supports any title for
// future expansion (administrative procedure citations from Title 5,
// etc.).
//
// Cache key is "title-section[(subsection)]" — versionless, because
// uscode.house.gov serves the prelim edition that updates monthly. The
// 30-day TTL acts as the version bump cadence (BUILD_PLAN §34).
import { z } from 'zod';
import { cachedLookup } from '../cache.js';
import { fetchUpstream, stripHtmlToText } from '../http.js';

export const uscInputSchema = z.object({
  title: z.coerce.number().int().min(1).max(54).default(26),
  section: z.string().min(1).max(64),
  subsection: z.string().max(64).optional(),
});

export type UscInput = z.infer<typeof uscInputSchema>;

export interface UscOutput {
  cite: string;
  url: string;
  text: string;
  fromCache: boolean;
  cacheAgeSeconds: number;
}

export async function uscLookup(input: UscInput): Promise<UscOutput> {
  const cite = formatUscCite(input);
  const cacheKey = canonicalKey(input);

  const cached = await cachedLookup('usc', cacheKey, async () => {
    const url = uscUrl(input);
    const res = await fetchUpstream(url);
    // uscode.house.gov serves XHTML — strip down to the readable section
    // body. The bulk USLM XML mirror is a Phase 35 follow-up; for v1.5
    // the XHTML view + strip is good enough for citation verification.
    const parsed = stripHtmlToText(res.text);
    return {
      canonicalUrl: url,
      rawText: res.text,
      parsedText: parsed,
      metadata: { title: input.title, section: input.section },
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

function canonicalKey(input: UscInput): string {
  const sub = input.subsection ? `(${input.subsection})` : '';
  return `${input.title}-${input.section}${sub}`;
}

function formatUscCite(input: UscInput): string {
  const sub = input.subsection ? `(${input.subsection})` : '';
  return `${input.title} U.S.C. § ${input.section}${sub}`;
}

function uscUrl(input: UscInput): string {
  // uscode.house.gov's per-section view URL. The `prelim` edition is the
  // continuously-updated version (positive law plus latest amendments)
  // that researchers expect; classification-table URLs go via a different
  // endpoint that's exposed on the pl_lookup tool.
  const granule = `USC-prelim-title${input.title}-section${input.section}`;
  return `https://uscode.house.gov/view.xhtml?req=granuleid:${granule}&num=0&edition=prelim`;
}
