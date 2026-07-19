// TP-8 — partner review screen: per-strategy checklist cards, the
// elevated-risk hard gate (checkbox disabled until a research archive is
// linked), the "Research this" launcher, and lifecycle transitions.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanStatus } from '@vibe/shared';
import { api } from '../../lib/api';
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

const NEXT_STATUS: Partial<Record<PlanStatus, PlanStatus[]>> = {
  draft: ['in-review'],
  'in-review': ['draft', 'presented'],
  presented: ['engaged', 'archived'],
  engaged: ['delivered', 'archived'],
  delivered: ['archived'],
};

export function ReviewTab({ detail }: { detail: PlanDetail }) {
  const { plan } = detail;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="max-w-3xl space-y-4">
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
