// TP-14 — Claude-drafted plan memo. Gated by the PLAN_MEMOS_ENABLED
// setting; ALWAYS draft-labeled; 503 when Claude is unavailable. The
// memo narrates numbers the deterministic engine already computed —
// Claude never computes tax.
import { Router } from 'express';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  clients,
  plan_memos,
  plan_results,
  plan_scenarios,
  plans,
  SETTING_KEYS,
} from '@vibe/db/schema';
import { VibeAiError } from '@kisaes/vibe-ai-client';
import { getSetting } from '../../lib/settings-store.js';
import { callClaude, ClaudeDisabledError } from '../../lib/anthropic/client.js';
import { audit } from '../../lib/audit.js';

export const planMemoRouter = Router({ mergeParams: true });

// Router-mode configuration denials: operator-setup situations (policy row
// missing/disabled, scrubber posture, class not enabled for the pool, token
// or budget problems) — the same "check the backend config" 503 as
// direct-path unavailability, never a raw 500.
const ROUTER_DENIAL_CODES: ReadonlySet<string> = new Set([
  'policy_blocked',
  'scrubber_blocked',
  'capability_missing',
  'auth_error',
  'budget_exceeded',
]);

/** Archived plans are read-only; every other status stays editable so an
 *  advisor can keep annotating a memo after the plan is presented. */
const MEMO_LOCKED_STATUSES = ['archived'];

async function loadPlanForMemo(planId: string) {
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  return plan ?? null;
}

async function loadMemo(planId: string) {
  const [memo] = await getDb()
    .select()
    .from(plan_memos)
    .where(eq(plan_memos.plan_id, planId))
    .limit(1);
  return memo ?? null;
}

const MEMO_INSTRUCTIONS = `You are drafting an internal planning memo for a CPA reviewing a tax
plan. You get the client profile summary, the computed baseline and scenario results (already
computed by a deterministic engine — do NOT recompute or adjust any number), and the selected
strategies. Write a concise memo in Markdown: situation, what the modeled plan does, the year-one
effect using ONLY the provided figures, key caveats, and open items for the reviewer. Professional
register, no hype. Do not invent numbers, authorities, or savings.`;

// ── Saved memo (read) ────────────────────────────────────────────────────
// Not gated by PLAN_MEMOS_ENABLED: that setting governs Claude drafting,
// and a hand-written memo must stay readable even with Claude switched off.
planMemoRouter.get('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!z.string().uuid().safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlanForMemo(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const memo = await loadMemo(planId);
  res.json({
    memo: memo
      ? {
          body_markdown: memo.body_markdown,
          claude_drafted: memo.claude_drafted,
          updated_at: memo.updated_at,
          updated_by: memo.updated_by,
        }
      : null,
    editable: !MEMO_LOCKED_STATUSES.includes(plan.status),
  });
});

// ── Saved memo (create/update) ───────────────────────────────────────────
// The WYSIWYG editor serializes its document to markdown and PUTs it here.
// `claude_drafted` is set only by the drafting flow below; a manual save
// clears it, which is what lets the UI retire the "unreviewed draft" banner.
const saveSchema = z.object({
  body_markdown: z.string().max(200_000),
  claude_drafted: z.boolean().optional(),
});

planMemoRouter.put('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  const parsed = saveSchema.safeParse(req.body ?? {});
  if (!z.string().uuid().safeParse(planId).success || !parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const plan = await loadPlanForMemo(planId);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (MEMO_LOCKED_STATUSES.includes(plan.status)) {
    res.status(409).json({ error: 'plan_archived', message: 'Archived plans are read-only.' });
    return;
  }
  const now = new Date();
  const claudeDrafted = parsed.data.claude_drafted === true;
  const [row] = await getDb()
    .insert(plan_memos)
    .values({
      plan_id: planId,
      body_markdown: parsed.data.body_markdown,
      claude_drafted: claudeDrafted,
      created_by: req.auth!.user_id,
      updated_by: req.auth!.user_id,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: plan_memos.plan_id,
      set: {
        body_markdown: parsed.data.body_markdown,
        claude_drafted: claudeDrafted,
        updated_by: req.auth!.user_id,
        updated_at: now,
      },
    })
    .returning();
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'plan.memo_saved',
    target_type: 'plan',
    target_id: planId,
    metadata: {
      client_id: plan.client_id,
      chars: parsed.data.body_markdown.length,
      claude_drafted: claudeDrafted,
    },
    ip: req.ip,
  });
  res.json({
    memo: {
      body_markdown: row!.body_markdown,
      claude_drafted: row!.claude_drafted,
      updated_at: row!.updated_at,
      updated_by: row!.updated_by,
    },
  });
});

// ── Claude draft ─────────────────────────────────────────────────────────
// Returns text for the editor to load; deliberately does NOT persist, so
// drafting can never overwrite an edited memo without an explicit save.
planMemoRouter.post('/', async (req, res) => {
  const planId = (req.params as { id?: string }).id ?? '';
  if (!z.string().uuid().safeParse(planId).success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const enabled = await getSetting<boolean>(SETTING_KEYS.PLAN_MEMOS_ENABLED);
  if (enabled !== true) {
    res
      .status(403)
      .json({ error: 'memos_disabled', message: 'Enable plan memos in Admin → Settings.' });
    return;
  }
  const db = getDb();
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, plan.client_id)).limit(1);
  const scenarios = await db
    .select()
    .from(plan_scenarios)
    .where(eq(plan_scenarios.plan_id, planId));
  const baseline = await db
    .select()
    .from(plan_results)
    .where(eq(plan_results.plan_id, planId))
    .orderBy(asc(plan_results.year));
  const baselineRows = baseline.filter((r) => r.scenario_id === null);
  const scenarioRows = baseline.filter((r) => r.scenario_id !== null);
  if (baselineRows.length === 0) {
    res
      .status(409)
      .json({ error: 'no_results', message: 'Compute the plan before drafting a memo.' });
    return;
  }

  const context = {
    client: client?.name ?? 'the client',
    plan: {
      title: plan.title,
      status: plan.status,
      years: plan.years,
      growth_pct: plan.growth_pct,
    },
    baseline_profile: plan.baseline_profile,
    scenarios: scenarios.map((s) => ({ id: s.id, label: s.label, selections: s.selections })),
    baseline_results: baselineRows.map((r) => ({ year: r.year, summary: r.result })),
    scenario_results: scenarioRows.map((r) => ({
      scenario_id: r.scenario_id,
      year: r.year,
      summary: r.result,
    })),
  };

  try {
    const r = await callClaude(
      'plan-memo',
      {
        messages: [
          {
            role: 'user',
            content: `${MEMO_INSTRUCTIONS}\n\nPLAN CONTEXT:\n${JSON.stringify(context)}`,
          },
        ],
      },
      { actorUserId: req.auth!.user_id },
    );
    const memo = `> **DRAFT — Claude-generated, not reviewed. Verify every figure and citation before any client use.**\n\n${r.text.trim()}`;
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'plan.memo_drafted',
      target_type: 'plan',
      target_id: planId,
      metadata: { client_id: plan.client_id, response_hash: r.response_hash },
    });
    res.json({ memo_markdown: memo, draft: true });
  } catch (err) {
    if (
      err instanceof ClaudeDisabledError ||
      (err instanceof VibeAiError && ROUTER_DENIAL_CODES.has(err.code)) ||
      (err as Error).message?.includes('not configured')
    ) {
      res.status(503).json({
        error: 'claude_unavailable',
        message:
          'Memo drafting is currently unavailable. Check the AI backend configuration (key, kill switch, or router policy).',
      });
      return;
    }
    throw err;
  }
});
