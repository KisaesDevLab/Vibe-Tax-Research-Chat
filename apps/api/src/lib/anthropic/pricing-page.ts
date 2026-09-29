// Live pricing from Anthropic's published pricing table.
//
// The Models API says which models exist but carries no prices, so without
// this the refresh can only price a model the bundled manifest already knew
// about at release time. The docs site serves the pricing page as markdown;
// its "Model pricing" table is parsed here.
//
// This is a documentation page, not an API contract, so everything about it
// is treated as untrusted: a row is kept only if every price parses and the
// prices are mutually plausible, and the whole result is discarded unless
// enough rows survive. A failure here must degrade to the manifest, never
// produce a diff — and the diff itself is still admin-reviewed before apply.

import { logger } from '../logger.js';

export interface LivePrice {
  model_id: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  // The 1-HOUR cache write rate. Every cache breakpoint this app sets uses
  // ttl '1h' (lib/anthropic/chat.ts), which bills at 2x input — the 5-minute
  // rate would under-report every cache write.
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
}

export type LivePricingResult = { ok: true; prices: LivePrice[] } | { ok: false; error: string };

// Fewer surviving rows than this means the page changed shape.
const MIN_ROWS = 5;

function parseUsd(cell: string): number | null {
  const m = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/i.exec(cell);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// "Claude Opus 4.1 ([retired, …](https://…))" → "Claude Opus 4.1"
function cleanName(cell: string): string {
  return cell
    .replace(/\(\s*\[.*$/, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

// "Claude Opus 5.5" → "claude-opus-5-5". The registry keys every model by
// this dateless alias form (see normalizeModelId in routes/admin/models.ts).
export function modelIdFromDisplayName(name: string): string | null {
  if (!/^Claude [A-Za-z]+ [0-9]+(\.[0-9]+)?$/.test(name)) return null;
  return name.toLowerCase().replace(/[ .]/g, '-');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function parsePricingMarkdown(md: string): LivePricingResult {
  const lines = md.split(/\r?\n/);
  const headerIdx = lines.findIndex(
    (l) => /^\s*\|/.test(l) && /base input/i.test(l) && /cache/i.test(l) && /output/i.test(l),
  );
  if (headerIdx < 0) return { ok: false, error: 'pricing_table_not_found' };

  // Locate columns by header text rather than position, so a reordered or
  // widened table is either read correctly or rejected — never misread.
  const header = splitRow(lines[headerIdx]!).map((h) => h.toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cols = {
    name: col(/^model$/),
    input: col(/base input/),
    write1h: col(/1h cache write/),
    read: col(/cache hit/),
    output: col(/^output/),
  };
  if (Object.values(cols).some((i) => i < 0)) {
    return { ok: false, error: 'pricing_table_columns_changed' };
  }

  const prices: LivePrice[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!/^\s*\|/.test(line)) break;
    const cells = splitRow(line);
    const display_name = cleanName(cells[cols.name] ?? '');
    const model_id = modelIdFromDisplayName(display_name);
    const input = parseUsd(cells[cols.input] ?? '');
    const output = parseUsd(cells[cols.output] ?? '');
    const write = parseUsd(cells[cols.write1h] ?? '');
    const read = parseUsd(cells[cols.read] ?? '');
    if (!model_id || input === null || output === null || write === null || read === null) {
      continue;
    }
    // Plausibility: a cache read is a discount, a cache write a premium, and
    // output costs more than input. A row breaking these was misparsed.
    if (!(read < input && input < write && input < output)) continue;
    if (seen.has(model_id)) continue;
    seen.add(model_id);
    prices.push({
      model_id,
      display_name,
      input_per_mtok: input,
      output_per_mtok: output,
      cache_write_per_mtok: write,
      cache_read_per_mtok: read,
    });
  }

  if (prices.length < MIN_ROWS) return { ok: false, error: 'pricing_table_unparseable' };
  return { ok: true, prices };
}

export async function fetchLivePricing(url: string): Promise<LivePricingResult> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'text/markdown, text/plain' },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const result = parsePricingMarkdown(await r.text());
    if (!result.ok) logger.warn({ error: result.error, url }, 'live pricing page rejected');
    return result;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
