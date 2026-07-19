// TP-12 — the runtime authoring pipeline. Claude drafts a refreshed
// strategy record against the v1.0 schema; the draft is validated by
// @vibe/schema, retried once with validator feedback, then parked as a
// draft strategy_versions row + a review_queue item. NOTHING publishes
// without a human decision (docs/strategy-schema.md gate 6).
//
// No Anthropic key configured → the job logs a skip and succeeds. The
// pipeline is a feature that lights up when credentials arrive.
import { eq, desc } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { strategies, strategy_versions, review_queue, table_sets } from '@vibe/db/schema';
import { validateStrategyRecord, type ValidationError } from '@vibe/schema';
import { callClaude, ClaudeDisabledError } from '../../lib/anthropic/client.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';

function bumpMinor(semver: string): string {
  const [maj, min] = semver.split('.').map((n) => parseInt(n, 10));
  return `${maj ?? 1}.${(min ?? 0) + 1}.0`;
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const AUTHOR_INSTRUCTIONS = `You are drafting a refresh of a tax-strategy record for a CPA firm's
planning library (schema v1.0). You will receive the CURRENT record JSON and the current
published tax-table figures. Produce a COMPLETE updated record as a single JSON object with
IDENTICAL structure and key set. Rules:
- Keep every machine field unchanged: id, category, modeled, model.applyOrder, model.inputs,
  model.apply, model.suggest, model.goldenTests, suggest, advisor.interactions, entityTypes,
  complexity, riskRating, typicalSavingsBand, engagement.implementationEffort.
- Refresh prose only where the law or figures have moved; otherwise keep the existing prose.
- Bump "version" (minor), set "status" to "draft", set "reviewedBy" to null, append a changeLog
  entry describing what changed and why.
- Citations must be real and correctly formatted (IRC §X / Reg. §1.X-Y / full case cite with
  reporter / Rev. Proc. N). Never invent authority.
- Client prose: ≤ grade-9 reading level; never use "loophole", "trick", "secret", "guarantee".
- stateNotes must address conformity, PTET interaction, and Missouri.
Return ONLY the JSON object.`;

export interface DraftResult {
  status: 'skipped-no-key' | 'draft-created' | 'validation-failed';
  version_id?: string;
  errors?: ValidationError[];
}

export async function draftStrategy(strategyId: string, triggeredBy: string): Promise<DraftResult> {
  const db = getDb();
  const [strategy] = await db
    .select()
    .from(strategies)
    .where(eq(strategies.id, strategyId))
    .limit(1);
  if (!strategy) throw new Error(`unknown strategy ${strategyId}`);

  const [current] = strategy.current_version_id
    ? await db
        .select()
        .from(strategy_versions)
        .where(eq(strategy_versions.id, strategy.current_version_id))
        .limit(1)
    : await db
        .select()
        .from(strategy_versions)
        .where(eq(strategy_versions.strategy_id, strategyId))
        .orderBy(desc(strategy_versions.created_at))
        .limit(1);
  if (!current) throw new Error(`no versions for strategy ${strategyId}`);

  const [tables] = await db
    .select()
    .from(table_sets)
    .where(eq(table_sets.status, 'published'))
    .orderBy(desc(table_sets.tax_year))
    .limit(1);

  const baseContent = JSON.stringify(current.content);
  const tableDigest = tables
    ? JSON.stringify({
        tax_year: tables.tax_year,
        version: tables.version,
        payload: tables.payload,
      })
    : 'none published';

  const callOnce = async (feedback: ValidationError[] | null) => {
    const feedbackBlock = feedback
      ? `\n\nYour previous draft FAILED validation. Fix exactly these problems and return the full corrected record:\n${feedback
          .map((e) => `- [${e.gate}] ${e.path}: ${e.message}`)
          .join('\n')}`
      : '';
    const r = await callClaude('strategy-author', {
      messages: [
        {
          role: 'user',
          content: `${AUTHOR_INSTRUCTIONS}\n\nCURRENT RECORD:\n${baseContent}\n\nPUBLISHED TABLE SET:\n${tableDigest}${feedbackBlock}`,
        },
      ],
    });
    return extractJson(r.text);
  };

  let draft;
  try {
    draft = await callOnce(null);
  } catch (err) {
    if (err instanceof ClaudeDisabledError) {
      logger.info({ strategyId }, 'strategy-author: kill switch on — skipping');
      return { status: 'skipped-no-key' };
    }
    if ((err as Error).message?.includes('not configured')) {
      logger.info({ strategyId }, 'strategy-author: no Anthropic key — skipping (pipeline idle)');
      return { status: 'skipped-no-key' };
    }
    throw err;
  }
  let validation = draft
    ? validateStrategyRecord(draft)
    : {
        ok: false,
        errors: [{ gate: 'schema' as const, path: '(root)', message: 'no JSON returned' }],
      };
  if (!validation.ok) {
    draft = await callOnce(validation.errors);
    validation = draft
      ? validateStrategyRecord(draft)
      : {
          ok: false,
          errors: [
            { gate: 'schema' as const, path: '(root)', message: 'no JSON returned on retry' },
          ],
        };
  }

  if (!draft) {
    logger.warn({ strategyId }, 'strategy-author: model returned no parseable JSON twice');
    return { status: 'validation-failed', errors: validation.errors };
  }

  // Semver: trust the draft's bump when sane, else force a minor bump.
  const draftVersion =
    typeof draft.version === 'string' && /^\d+\.\d+\.\d+$/.test(draft.version)
      ? draft.version
      : bumpMinor(current.semver);
  const model = draft.model as
    | {
        inputs?: Record<string, unknown>;
        suggest?: Record<string, unknown>;
        apply?: { module?: string };
        applyOrder?: number;
      }
    | undefined;

  const [version] = await db
    .insert(strategy_versions)
    .values({
      strategy_id: strategyId,
      semver: draftVersion,
      status: 'draft',
      content: draft,
      inputs_schema: model?.inputs ?? null,
      suggest_rule: model?.suggest ?? (draft.suggest as Record<string, unknown>) ?? null,
      apply_module_ref: model?.apply?.module ?? null,
      apply_order: model?.applyOrder ?? null,
      change_note: `pipeline draft (${triggeredBy})`,
      created_by: 'pipeline',
    })
    .onConflictDoNothing()
    .returning({ id: strategy_versions.id });

  if (!version) {
    logger.info({ strategyId, draftVersion }, 'strategy-author: version already exists — skipping');
    return { status: 'draft-created' };
  }

  // TP-14 — a draft that changes the MATH (module ref, apply order, or
  // inputs schema) can't just be approved: the TS module itself must be
  // reviewed/shipped. Flag it so the queue makes that unmissable.
  const currentModel = (current.content as { model?: Record<string, unknown> }).model;
  const needsModuleChange =
    JSON.stringify({
      m: model?.apply?.module ?? null,
      o: model?.applyOrder ?? null,
      i: model?.inputs ?? null,
    }) !==
    JSON.stringify({
      m: (currentModel?.apply as { module?: string } | undefined)?.module ?? null,
      o: currentModel?.applyOrder ?? null,
      i: currentModel?.inputs ?? null,
    });

  await db.insert(review_queue).values({
    kind: 'strategy-draft',
    payload: {
      strategy_id: strategyId,
      version_id: version.id,
      semver: draftVersion,
      base_semver: current.semver,
      validation: { ok: validation.ok, errors: validation.errors },
      needs_module_change: needsModuleChange,
      triggered_by: triggeredBy,
    },
    created_by: 'job',
  });
  await audit({
    actor_user_id: null,
    action: 'strategy.pipeline_draft',
    target_type: 'strategy',
    target_id: strategyId,
    metadata: { version_id: version.id, semver: draftVersion, valid: validation.ok },
  });
  logger.info(
    { strategyId, version_id: version.id, valid: validation.ok },
    'strategy-author: draft parked in review queue',
  );
  return validation.ok
    ? { status: 'draft-created', version_id: version.id }
    : { status: 'validation-failed', version_id: version.id, errors: validation.errors };
}
