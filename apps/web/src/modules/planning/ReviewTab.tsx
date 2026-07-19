// TP-8 — partner review screen: per-strategy checklist cards, the
// elevated-risk hard gate (checkbox disabled until a research archive is
// linked), the "Research this" launcher, and lifecycle transitions.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanStatus } from '@vibe/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../components/AuthProvider';
import type { PlanDetail } from './PlanDetailPage';

interface GateResponse {
  gate: { ok: boolean; failures: Array<{ code: string; strategyId?: string; message: string }> };
  checklist: Array<{
    strategyId: string;
    riskRating: string;
    items: string[];
    linked: boolean;
    selected: boolean;
  }>;
}

interface LinksResponse {
  links: Array<{
    id: string;
    strategy_id: string | null;
    research_archive_id: string;
    title: string;
    status: string;
  }>;
  candidates: Array<{ id: string; title: string; topic_tags: string[]; archived_at: string }>;
}

interface EngagementDTO {
  letter_status: string;
  payment_status: string;
  events: Array<{ at: string; source: string; kind: string }>;
}

function EngagementPanel({ planId, onChanged }: { planId: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ engagement: EngagementDTO }>({
    queryKey: ['engagement', planId],
    queryFn: () => api(`/api/planning/plans/${planId}/engagement`),
  });
  const override = useMutation({
    mutationFn: (step: string) =>
      api(`/api/planning/plans/${planId}/engagement/override`, {
        method: 'POST',
        body: JSON.stringify({ step }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['engagement', planId] });
      onChanged();
    },
    onError: (err) => setError((err as Error).message),
  });
  const e = data?.engagement;
  if (!e) return null;
  return (
    <section className="border border-ink/10 rounded p-4 bg-white">
      <h3 className="font-display text-lg mb-2">Engagement</h3>
      <div className="flex flex-wrap gap-4 text-sm mb-2">
        <span>
          Letter: <span className="font-medium">{e.letter_status}</span>
        </span>
        <span>
          Payment: <span className="font-medium">{e.payment_status}</span>
        </span>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap gap-2 text-xs">
          {['letter-sent', 'letter-signed', 'invoice-sent', 'payment-received'].map((step) => (
            <button
              key={step}
              onClick={() => override.mutate(step)}
              disabled={override.isPending}
              className="px-2 py-1 border border-ink/20 rounded hover:bg-ink/5 disabled:opacity-50"
              title="Admin manual override — used when OpenSign/Stripe are not configured"
            >
              Record {step}
            </button>
          ))}
        </div>
      )}
      <p className="text-[11px] text-ink/40 mt-2">
        Signed + paid auto-advances the plan to engaged and unlocks strategy names in client
        deliverables. OpenSign/Stripe webhooks drive this automatically when configured.
      </p>
      {error && <div className="text-oxblood text-xs mt-1">{error}</div>}
      {e.events.length > 0 && (
        <ul className="mt-2 text-[11px] text-ink/50 space-y-0.5">
          {e.events.slice(-5).map((ev, i) => (
            <li key={i}>
              {new Date(ev.at).toLocaleString()} · {ev.source} · {ev.kind}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const NEXT_STATUS: Partial<Record<PlanStatus, PlanStatus[]>> = {
  draft: ['in-review'],
  'in-review': ['draft', 'presented'],
  presented: ['engaged', 'archived'],
  engaged: ['delivered', 'archived'],
  delivered: ['archived'],
};

interface ReviewersResponse {
  reviewers: Array<{ id: string; email: string; display_name: string | null }>;
}

export function ReviewTab({ detail }: { detail: PlanDetail }) {
  const { plan } = detail;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [memoMarkdown, setMemoMarkdown] = useState<string | null>(null);
  const [memoError, setMemoError] = useState<string | null>(null);

  const canPickReviewer = plan.status === 'draft' || plan.status === 'in-review';
  const { data: reviewersData } = useQuery<ReviewersResponse>({
    queryKey: ['planning-reviewers'],
    queryFn: () => api('/api/planning/reviewers'),
    enabled: canPickReviewer,
  });

  const { data: gateData } = useQuery<GateResponse>({
    queryKey: ['plan-gate', plan.id, plan.updated_at],
    queryFn: () => api(`/api/planning/plans/${plan.id}/review-gate`),
  });
  const { data: linksData } = useQuery<LinksResponse>({
    queryKey: ['plan-links', plan.id],
    queryFn: () => api(`/api/planning/plans/${plan.id}/research-links`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['plan', plan.id] });
    qc.invalidateQueries({ queryKey: ['plan-gate', plan.id] });
    qc.invalidateQueries({ queryKey: ['plan-links', plan.id] });
  };

  const saveState = useMutation({
    mutationFn: (review_state: Record<string, boolean>) =>
      api(`/api/planning/plans/${plan.id}/review-state`, {
        method: 'PATCH',
        body: JSON.stringify({ review_state }),
      }),
    onSuccess: invalidate,
    onError: (err) => setError((err as Error).message),
  });

  const transition = useMutation({
    mutationFn: (to: PlanStatus) =>
      api(`/api/planning/plans/${plan.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: invalidate,
    onError: (err) => setError((err as Error).message),
  });

  const link = useMutation({
    mutationFn: (input: { research_archive_id: string; strategy_id: string | null }) =>
      api(`/api/planning/plans/${plan.id}/research-links`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
    onError: (err) => setError((err as Error).message),
  });

  const setReviewer = useMutation({
    mutationFn: (reviewer_id: string | null) =>
      api(`/api/planning/plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ reviewer_id }),
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError((err as Error).message),
  });

  const memo = useMutation({
    mutationFn: () =>
      api<{ memo_markdown: string }>(`/api/planning/plans/${plan.id}/memo`, { method: 'POST' }),
    onSuccess: (r) => {
      setMemoError(null);
      setMemoMarkdown(r.memo_markdown);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          setMemoError('Plan memos are disabled in Admin → Settings.');
          return;
        }
        if (err.status === 409) {
          setMemoError('Compute the plan first.');
          return;
        }
        if (err.status === 503) {
          setMemoError('Claude is not configured on this appliance.');
          return;
        }
      }
      setMemoError((err as Error).message);
    },
  });

  const launch = useMutation({
    mutationFn: (strategy_id: string) =>
      api<{ chat_id: string }>(`/api/planning/plans/${plan.id}/research-launch`, {
        method: 'POST',
        body: JSON.stringify({ strategy_id }),
      }),
    onSuccess: (r) => navigate(`/research/${r.chat_id}`),
    onError: (err) => setError((err as Error).message),
  });

  const checklist = (gateData?.checklist ?? []).filter((c) => c.selected);
  const editable = plan.status === 'in-review';

  const reviewers = reviewersData?.reviewers ?? [];
  // Keep the current reviewer visible even if the list hasn't loaded (or
  // no longer contains them) — the server enforces reviewer ≠ preparer at
  // transition time, so no one is excluded client-side.
  const reviewerKnown = plan.reviewer_id && reviewers.some((r) => r.id === plan.reviewer_id);

  return (
    <div className="max-w-3xl space-y-4">
      {canPickReviewer && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="reviewing-partner" className="text-sm text-ink/60">
            Reviewing partner:
          </label>
          <select
            id="reviewing-partner"
            value={plan.reviewer_id ?? ''}
            disabled={setReviewer.isPending}
            onChange={(e) => setReviewer.mutate(e.target.value === '' ? null : e.target.value)}
            className="px-2 py-1 border border-ink/20 rounded text-sm bg-white disabled:opacity-50"
          >
            <option value="">— none —</option>
            {plan.reviewer_id && !reviewerKnown && (
              <option value={plan.reviewer_id}>current reviewer</option>
            )}
            {reviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.display_name ?? r.email}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink/60">Lifecycle:</span>
        <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded bg-ink text-paper">
          {plan.status}
        </span>
        {(NEXT_STATUS[plan.status] ?? []).map((to) => (
          <button
            key={to}
            onClick={() => transition.mutate(to)}
            disabled={transition.isPending}
            className="px-2.5 py-1 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-50"
          >
            → {to}
          </button>
        ))}
      </div>
      {error && <div className="text-oxblood text-sm whitespace-pre-wrap">{error}</div>}
      {gateData && !gateData.gate.ok && plan.status === 'in-review' && (
        <div className="border border-gold/40 bg-gold/10 rounded p-3 text-sm">
          <div className="font-medium mb-1">Blocking “presented”:</div>
          <ul className="list-disc pl-5 space-y-0.5">
            {gateData.gate.failures.map((f, i) => (
              <li key={i}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}

      {checklist.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-6 text-center">
          No strategies selected yet — the review checklist builds from the scenario selections.
        </div>
      ) : (
        checklist.map((c) => (
          <section key={c.strategyId} className="border border-ink/10 rounded p-4 bg-white">
            <div className="flex items-baseline gap-2 mb-2">
              <h3 className="font-medium">{c.strategyId}</h3>
              {c.riskRating === 'elevated' && (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-oxblood/10 text-oxblood">
                  elevated risk
                </span>
              )}
              {c.riskRating === 'elevated' &&
                (c.linked ? (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-moss/15 text-moss">
                    research linked
                  </span>
                ) : (
                  <button
                    onClick={() => launch.mutate(c.strategyId)}
                    disabled={launch.isPending}
                    className="text-xs underline text-oxblood"
                  >
                    Research this →
                  </button>
                ))}
            </div>
            <ul className="space-y-1">
              {c.items.map((item, i) => {
                const key = `${c.strategyId}:${i}`;
                const blocked = c.riskRating === 'elevated' && !c.linked;
                return (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={plan.review_state[key] === true}
                      disabled={!editable || blocked}
                      title={
                        blocked
                          ? 'Link an archived research session before checking off this strategy.'
                          : undefined
                      }
                      onChange={(e) =>
                        saveState.mutate({ ...plan.review_state, [key]: e.target.checked })
                      }
                    />
                    <span className={blocked ? 'text-ink/40' : ''}>{item}</span>
                  </li>
                );
              })}
            </ul>
            {c.riskRating === 'elevated' && !c.linked && linksData && (
              <div className="mt-3 border-t border-ink/10 pt-2">
                <div className="text-xs text-ink/60 mb-1">
                  Link an archived research session to unlock:
                </div>
                {linksData.candidates.length === 0 ? (
                  <div className="text-xs text-ink/40">
                    No archived research for this client yet — use “Research this” and archive the
                    session.
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {linksData.candidates.map((cand) => (
                      <li key={cand.id} className="flex items-center gap-2 text-xs">
                        <button
                          onClick={() =>
                            link.mutate({
                              research_archive_id: cand.id,
                              strategy_id: c.strategyId,
                            })
                          }
                          className="underline text-moss"
                        >
                          link
                        </button>
                        <span className="truncate">{cand.title}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        ))
      )}

      {['presented', 'engaged', 'delivered'].includes(plan.status) && (
        <EngagementPanel planId={plan.id} onChanged={invalidate} />
      )}

      {plan.status !== 'draft' && (
        <section className="border border-ink/10 rounded p-4 bg-white">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-display text-lg">Plan memo</h3>
            <button
              onClick={() => memo.mutate()}
              disabled={memo.isPending}
              className="px-2.5 py-1 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-50"
            >
              {memo.isPending ? 'Drafting…' : 'Draft memo (Claude)'}
            </button>
          </div>
          {memoError && <div className="text-oxblood text-sm mt-2">{memoError}</div>}
          {memoMarkdown && (
            <details open className="mt-2">
              <summary className="text-xs cursor-pointer text-ink/60">
                Memo draft (markdown)
              </summary>
              <pre className="mt-2 text-xs whitespace-pre-wrap border border-ink/10 rounded p-3 bg-paper overflow-x-auto">
                {memoMarkdown}
              </pre>
            </details>
          )}
        </section>
      )}

      {linksData && linksData.links.length > 0 && (
        <section className="border border-ink/10 rounded p-4 bg-white">
          <h3 className="font-display text-lg mb-2">Linked research sessions</h3>
          <ul className="text-sm space-y-1">
            {linksData.links.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <Link
                  to={`/clients/${plan.client_id}/research/${l.research_archive_id}`}
                  className="underline"
                >
                  {l.title}
                </Link>
                {l.strategy_id && <span className="text-xs text-ink/40">({l.strategy_id})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
