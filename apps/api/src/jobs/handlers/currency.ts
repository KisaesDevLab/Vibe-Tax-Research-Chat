// TP-14 — currency jobs: the machinery that keeps a published strategy
// library honest as law and figures move.
//
//   tables-draft      (Claude)   draft next year's table set + field diff
//   golden-regression (local)    re-run every golden against a table set
//   strategy-watch    (Claude)   scan monitoring keywords for developments
//   archive-scan      (local)    match firm research archives against
//                                strategy monitoring keywords
//
// Every finding lands in review_queue; NOTHING publishes from a job.
// Claude-dependent handlers degrade to a logged skip without a key.
import crypto from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  golden_tests,
  research_archives,
  review_queue,
  strategies,
  strategy_versions,
  table_sets,
} from '@vibe/db/schema';
import { composeScenario } from '@vibe/engine';
import { resolveApply } from '@vibe/strategies';
import { WEB_ALLOWLIST_DOMAINS, type BaselineProfile, type TableSetPayload } from '@vibe/shared';
import { callClaude, ClaudeDisabledError } from '../../lib/anthropic/client.js';
import { getRedis } from '../../lib/redis.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';

function isNoKeySkip(err: unknown): boolean {
  return (
    err instanceof ClaudeDisabledError ||
    Boolean((err as Error).message?.includes('not configured'))
  );
}

// ── field diff (exported for tests) ─────────────────────────────────────

export interface FieldDiff {
  path: string;
  from: unknown;
  to: unknown;
}

/** Flatten two payloads and report changed/added/removed leaf fields. */
export function diffTableFields(a: unknown, b: unknown, prefix = ''): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffs.push(...diffTableFields(a[key], b[key], prefix ? `${prefix}.${key}` : key));
    }
    return diffs;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs.push({ path: prefix, from: a, to: b });
  }
  return diffs;
}

// ── tables-draft ────────────────────────────────────────────────────────

const TABLES_DRAFT_INSTRUCTIONS = `You maintain the versioned tax-constant tables a deterministic
planning engine computes from. Given the CURRENT published table-set JSON for a tax year,
produce the DRAFT for the NEXT tax year as a single JSON object:
{"tax_year": <next year>, "payload": {…same structure, updated figures…},
 "source_notes": [{"group": "…", "authority": "…", "url": "…", "note": "…"}]}
Rules:
- Keep the payload structure IDENTICAL — same keys, same nesting, numbers only where numbers are.
- Use web search to VERIFY every figure against the official source (irs.gov Rev. Proc. /
  notices, ssa.gov COLA releases, statute text). Update only figures you confirmed; the
  authority AND URL in each source note must be the source you actually consulted.
- Where the next year's official figure is not yet published, KEEP the current figure and say so
  in that group's note ("carryover — official figure pending").
Return ONLY the JSON object.`;

export async function runTablesDraft(triggeredBy: string): Promise<void> {
  const db = getDb();
  const [current] = await db
    .select()
    .from(table_sets)
    .where(eq(table_sets.status, 'published'))
    .orderBy(desc(table_sets.tax_year), desc(table_sets.version))
    .limit(1);
  if (!current) {
    logger.warn('tables-draft: no published table set to draft from');
    return;
  }
  let draft: { tax_year?: number; payload?: TableSetPayload; source_notes?: unknown[] } | null =
    null;
  try {
    const r = await callClaude('tables-draft', {
      messages: [
        {
          role: 'user',
          content: `${TABLES_DRAFT_INSTRUCTIONS}\n\nCURRENT (${current.tax_year} v${current.version}):\n${JSON.stringify(
            {
              tax_year: current.tax_year,
              payload: current.payload,
              source_notes: current.source_notes,
            },
          )}`,
        },
      ],
      // Live grounding against the trusted-source allowlist. Server tool →
      // this job is pinned direct (not router-routable), same as
      // strategy-watch; the SDK seam passes the body through untyped.
      tools: [
        {
          type: 'web_search_20250828',
          name: 'web_search',
          max_uses: 8,
          allowed_domains: WEB_ALLOWLIST_DOMAINS,
        },
      ] as unknown as never,
    });
    const start = r.text.indexOf('{');
    const end = r.text.lastIndexOf('}');
    if (start !== -1 && end > start) draft = JSON.parse(r.text.slice(start, end + 1));
  } catch (err) {
    if (isNoKeySkip(err)) {
      logger.info('tables-draft: Claude unavailable — skipping (job idle without key)');
      return;
    }
    throw err;
  }
  if (!draft?.payload || typeof draft.tax_year !== 'number') {
    logger.warn('tables-draft: model returned no usable draft');
    return;
  }
  const draftYear = draft.tax_year;
  // Dedupe on the OPEN review item, not on the table_sets row — a
  // rejected draft must not block regeneration forever. Legacy items
  // predate the payload tax_year field, hence the subject fallback.
  const [openItem] = await db
    .select({ id: review_queue.id })
    .from(review_queue)
    .where(
      and(
        eq(review_queue.kind, 'table-draft'),
        eq(review_queue.status, 'open'),
        sql`(payload->>'tax_year' = ${String(draftYear)} or payload->>'subject' = ${`TABLES_${draftYear}`})`,
      ),
    )
    .limit(1);
  if (openItem) {
    logger.info(
      { tax_year: draftYear, review_item: openItem.id },
      'tables-draft: open table-draft review item already exists — skipping',
    );
    return;
  }
  // Rejected drafts keep their (tax_year, version) slot in the unique
  // index, so a regenerated draft takes the next version.
  const [maxRow] = await db
    .select({ maxVersion: sql<number | null>`max(${table_sets.version})` })
    .from(table_sets)
    .where(eq(table_sets.tax_year, draftYear));
  const nextVersion = Number(maxRow?.maxVersion ?? 0) + 1;
  const fieldDiff = diffTableFields(current.payload, draft.payload);
  // Draft row + review item are one atomic unit — an unreferenced draft
  // row would be invisible to reviewers yet block the version slot.
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(table_sets)
      .values({
        tax_year: draftYear,
        version: nextVersion,
        status: 'draft',
        payload: draft.payload!,
        source_notes: (draft.source_notes ?? []) as never,
      })
      .returning({ id: table_sets.id });
    await tx.insert(review_queue).values({
      kind: 'table-draft',
      payload: {
        subject: `TABLES_${draftYear}`,
        tax_year: draftYear,
        table_set_id: row!.id,
        base_table_set_id: current.id,
        base_tax_year: current.tax_year,
        field_diff: fieldDiff.slice(0, 400),
        source_notes: draft.source_notes ?? [],
        triggered_by: triggeredBy,
      },
      created_by: 'job',
    });
    return row!;
  });
  await audit({
    actor_user_id: null,
    action: 'table_set.pipeline_draft',
    target_type: 'table_set',
    target_id: inserted.id,
    metadata: { tax_year: draft.tax_year, changed_fields: fieldDiff.length },
  });
  logger.info(
    { tax_year: draft.tax_year, changed: fieldDiff.length },
    'tables-draft: draft parked in review queue',
  );
}

// ── golden-regression ───────────────────────────────────────────────────

export interface GoldenFailure {
  golden_id: string;
  strategy_id: string;
  name: string;
  expected: number;
  actual: number;
  drift: number;
  tolerance: number;
}

/** Re-run one golden against a table set. Pure aside from module lookup. */
export function runGoldenCase(
  golden: {
    profile: Record<string, unknown>;
    params: Record<string, unknown>;
    expected: Record<string, number>;
  },
  applyModuleRef: string,
  applyOrder: number,
  strategyId: string,
  payload: TableSetPayload,
  taxYear: number,
): { actual: number; expected: number } {
  const apply = resolveApply(applyModuleRef);
  const run = (transforms: Parameters<typeof composeScenario>[0]['transforms']) =>
    composeScenario({
      baseline: golden.profile as unknown as BaselineProfile,
      transforms,
      years: 1,
      growthPct: 0,
      tableSet: payload,
      startYear: taxYear,
    });
  const baseRun = run([]);
  const withRun = run([{ strategyId, applyOrder, params: golden.params, apply }]);
  return {
    actual: withRun.years[0]!.totalBurden - baseRun.years[0]!.totalBurden,
    expected: golden.expected.totalBurdenDelta ?? 0,
  };
}

export async function runGoldenRegression(tableSetId: string, triggeredBy: string): Promise<void> {
  const db = getDb();
  const [tableSet] = await db
    .select()
    .from(table_sets)
    .where(eq(table_sets.id, tableSetId))
    .limit(1);
  if (!tableSet) throw new Error(`golden-regression: unknown table set ${tableSetId}`);

  // Goldens attached to currently-published strategy versions only.
  const published = await db
    .select({
      version_id: strategy_versions.id,
      strategy_id: strategy_versions.strategy_id,
      apply_module_ref: strategy_versions.apply_module_ref,
      apply_order: strategy_versions.apply_order,
    })
    .from(strategy_versions)
    .innerJoin(strategies, eq(strategies.current_version_id, strategy_versions.id));
  const modeled = published.filter((v) => v.apply_module_ref && v.apply_order !== null);
  const goldens = modeled.length
    ? await db
        .select()
        .from(golden_tests)
        .where(
          inArray(
            golden_tests.strategy_version_id,
            modeled.map((v) => v.version_id),
          ),
        )
    : [];

  const failures: GoldenFailure[] = [];
  let ran = 0;
  for (const g of goldens) {
    const version = modeled.find((v) => v.version_id === g.strategy_version_id)!;
    try {
      const { actual, expected } = runGoldenCase(
        { profile: g.profile, params: g.params, expected: g.expected },
        version.apply_module_ref!,
        version.apply_order!,
        version.strategy_id,
        tableSet.payload as TableSetPayload,
        tableSet.tax_year,
      );
      ran += 1;
      const tolerance = Number(g.tolerance);
      if (Math.abs(actual - expected) > tolerance) {
        failures.push({
          golden_id: g.id,
          strategy_id: version.strategy_id,
          name: g.name,
          expected,
          actual,
          drift: actual - expected,
          tolerance,
        });
      }
    } catch (err) {
      failures.push({
        golden_id: g.id,
        strategy_id: version.strategy_id,
        name: g.name,
        expected: g.expected.totalBurdenDelta ?? 0,
        actual: Number.NaN,
        drift: Number.NaN,
        tolerance: Number(g.tolerance),
      });
      logger.warn({ err, golden: g.id }, 'golden-regression: case threw');
    }
  }

  if (failures.length > 0) {
    // One review item per affected strategy, drifts grouped.
    const byStrategy = new Map<string, GoldenFailure[]>();
    for (const f of failures) {
      byStrategy.set(f.strategy_id, [...(byStrategy.get(f.strategy_id) ?? []), f]);
    }
    for (const [strategyId, fails] of byStrategy) {
      await db.insert(review_queue).values({
        kind: 'golden-failure',
        payload: {
          strategy_id: strategyId,
          subject: `goldens vs TABLES_${tableSet.tax_year} v${tableSet.version}`,
          table_set_id: tableSet.id,
          failures: fails,
          triggered_by: triggeredBy,
        },
        created_by: 'job',
      });
    }
  }
  await audit({
    actor_user_id: null,
    action: 'golden_regression.run',
    target_type: 'table_set',
    target_id: tableSetId,
    metadata: { ran, failures: failures.length, triggered_by: triggeredBy },
  });
  logger.info({ tableSetId, ran, failures: failures.length }, 'golden-regression complete');
}

// ── strategy-watch ──────────────────────────────────────────────────────

const SEEN_TTL_SECONDS = 180 * 24 * 3600;

/**
 * A watch hit is only actionable when the model grounded it: a headline
 * to review and a source to verify. Exported for tests.
 */
export function isUsableWatchHit(hit: { headline?: unknown; source?: unknown }): boolean {
  return (
    typeof hit.headline === 'string' &&
    hit.headline.trim().length > 0 &&
    typeof hit.source === 'string' &&
    hit.source.trim().length > 0
  );
}

const WATCH_INSTRUCTIONS = `You monitor legal developments for a CPA firm's tax-strategy library.
For the strategy below you get its watch list (authorities + keywords) and last-review date.
Use web search to check for developments SINCE that date: new cases, IRS guidance, statutory
changes, or enforcement campaigns matching the watch list. Reply with STRICT JSON only:
{"hits": [{"headline": "…", "source": "…", "date": "YYYY-MM-DD", "why_it_matters": "…"}]}
Only include genuinely new, on-topic developments. Empty array when nothing new.`;

export async function runStrategyWatch(triggeredBy: string): Promise<void> {
  const db = getDb();
  const redis = getRedis();
  const rows = await db
    .select({
      strategy_id: strategy_versions.strategy_id,
      content: strategy_versions.content,
    })
    .from(strategy_versions)
    .innerJoin(strategies, eq(strategies.current_version_id, strategy_versions.id));

  let scanned = 0;
  let newHits = 0;
  for (const row of rows) {
    const content = row.content as {
      lastReviewed?: string;
      monitoring?: { watchAuthorities?: string[]; keywords?: string[] };
    };
    const monitoring = content.monitoring;
    if (!monitoring?.keywords?.length) continue;
    let hits: Array<{ headline: string; source: string; date: string; why_it_matters: string }> =
      [];
    try {
      const r = await callClaude('strategy-watch', {
        messages: [
          {
            role: 'user',
            content: `${WATCH_INSTRUCTIONS}\n\nStrategy: ${row.strategy_id}\nLast reviewed: ${
              content.lastReviewed ?? 'unknown'
            }\nWatch authorities: ${(monitoring.watchAuthorities ?? []).join('; ')}\nKeywords: ${monitoring.keywords.join(
              '; ',
            )}`,
          },
        ],
        // The SDK doesn't type the server-side web-search tool yet; the
        // seam passes the body through untyped (same pattern as chat.ts).
        tools: [
          { type: 'web_search_20250828', name: 'web_search', max_uses: 4 },
        ] as unknown as never,
      });
      const start = r.text.indexOf('{');
      const end = r.text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        const parsed = JSON.parse(r.text.slice(start, end + 1)) as { hits?: typeof hits };
        hits = Array.isArray(parsed.hits) ? parsed.hits : [];
      }
      scanned += 1;
    } catch (err) {
      if (isNoKeySkip(err)) {
        logger.info('strategy-watch: Claude unavailable — skipping (job idle without key)');
        return;
      }
      logger.warn({ err, strategy: row.strategy_id }, 'strategy-watch: scan failed — continuing');
      continue;
    }
    for (const hit of hits) {
      if (!isUsableWatchHit(hit)) continue; // ungrounded hit — nothing to review
      const key = `strategy-watch-seen:${crypto
        .createHash('sha256')
        .update(`${row.strategy_id}:${hit.headline}:${hit.source}`)
        .digest('hex')}`;
      // Review item BEFORE the seen-marker: a crash between the two makes
      // a duplicate review item (harmless), never a suppressed hit. The
      // GET/SET pair isn't atomic, but the queue runs a single worker and
      // a duplicate item is the acceptable failure direction.
      const seen = await redis.get(key);
      if (seen) continue; // seen within the TTL window
      newHits += 1;
      await db.insert(review_queue).values({
        kind: 'watch-hit',
        payload: {
          strategy_id: row.strategy_id,
          subject: hit.headline,
          hit,
          triggered_by: triggeredBy,
        },
        created_by: 'job',
      });
      await redis.set(key, '1', 'EX', SEEN_TTL_SECONDS);
    }
  }
  // Heartbeat even when quiet — silence must be distinguishable from breakage.
  await audit({
    actor_user_id: null,
    action: 'strategy_watch.run',
    target_type: 'job',
    target_id: 'strategy-watch',
    metadata: { scanned, new_hits: newHits, triggered_by: triggeredBy },
  });
  logger.info({ scanned, newHits }, 'strategy-watch complete');
}

// ── archive-scan (no API) ───────────────────────────────────────────────

export interface ArchiveScanHit {
  strategy_id: string;
  archive_id: string;
  keyword: string;
}

/** Pure matcher, exported for tests: keywords vs snapshot text. */
export function matchArchiveKeywords(
  strategiesIn: Array<{ id: string; lastReviewed: string; keywords: string[] }>,
  archives: Array<{ id: string; archived_at: Date; text: string }>,
): ArchiveScanHit[] {
  const hits: ArchiveScanHit[] = [];
  for (const s of strategiesIn) {
    const cutoff = new Date(s.lastReviewed);
    for (const a of archives) {
      if (!(a.archived_at > cutoff)) continue;
      const haystack = a.text.toLowerCase();
      const keyword = s.keywords.find((k) => k.length >= 4 && haystack.includes(k.toLowerCase()));
      if (keyword) hits.push({ strategy_id: s.id, archive_id: a.id, keyword });
    }
  }
  return hits;
}

export async function runArchiveScan(triggeredBy: string): Promise<void> {
  const db = getDb();
  const versions = await db
    .select({ strategy_id: strategy_versions.strategy_id, content: strategy_versions.content })
    .from(strategy_versions)
    .innerJoin(strategies, eq(strategies.current_version_id, strategy_versions.id));
  const watchable = versions
    .map((v) => {
      const c = v.content as {
        lastReviewed?: string;
        monitoring?: { keywords?: string[] };
      };
      return {
        id: v.strategy_id,
        lastReviewed: c.lastReviewed ?? '1970-01-01',
        keywords: c.monitoring?.keywords ?? [],
      };
    })
    .filter((s) => s.keywords.length > 0);
  const earliest = watchable.reduce(
    (min, s) => (s.lastReviewed < min ? s.lastReviewed : min),
    '9999-12-31',
  );
  const archives = await db
    .select({
      id: research_archives.id,
      archived_at: research_archives.archived_at,
      snapshot_text: research_archives.snapshot_text,
    })
    .from(research_archives)
    .where(
      and(
        eq(research_archives.status, 'active'),
        gt(research_archives.archived_at, new Date(earliest)),
      ),
    );

  const hits = matchArchiveKeywords(
    watchable,
    archives.map((a) => ({ id: a.id, archived_at: a.archived_at, text: a.snapshot_text })),
  );

  let opened = 0;
  for (const hit of hits) {
    // Dedup: skip when an open item already covers this pair.
    const [existing] = await db
      .select({ id: review_queue.id })
      .from(review_queue)
      .where(
        and(
          eq(review_queue.kind, 'archive-scan-hit'),
          eq(review_queue.status, 'open'),
          sql`payload->>'strategy_id' = ${hit.strategy_id}`,
          sql`payload->>'archive_id' = ${hit.archive_id}`,
        ),
      )
      .limit(1);
    if (existing) continue;
    opened += 1;
    await db.insert(review_queue).values({
      kind: 'archive-scan-hit',
      payload: {
        strategy_id: hit.strategy_id,
        archive_id: hit.archive_id,
        keyword: hit.keyword,
        subject: `${hit.strategy_id} ↔ archived research (“${hit.keyword}”)`,
        triggered_by: triggeredBy,
      },
      created_by: 'job',
    });
  }
  await audit({
    actor_user_id: null,
    action: 'archive_scan.run',
    target_type: 'job',
    target_id: 'archive-scan',
    metadata: {
      strategies: watchable.length,
      archives: archives.length,
      hits: hits.length,
      opened,
    },
  });
  logger.info({ hits: hits.length, opened }, 'archive-scan complete');
}
