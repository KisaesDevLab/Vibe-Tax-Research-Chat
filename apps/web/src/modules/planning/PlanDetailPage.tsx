// TP-6 — plan detail: Profile (JSON editor until the TP-7 typed intake
// form) · Strategies (picker with suggest badges + schema-driven param
// forms) · Results (baseline vs scenario compare).
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanDTO, PlanScenarioDTO, PlanResultDTO } from '@vibe/shared';
import { api, ApiError } from '../../lib/api';
import { StrategiesTab } from './StrategiesTab';
import { ScenarioCompare } from './ScenarioCompare';
import { ProfileTab } from './ProfileTab';
import { ReviewTab } from './ReviewTab';
import { DeliverablesTab } from './DeliverablesTab';

export interface PlanDetail {
  plan: PlanDTO;
  scenarios: PlanScenarioDTO[];
  results: PlanResultDTO[];
}

const TABS = ['profile', 'strategies', 'results', 'review', 'deliverables'] as const;
type PlanTab = (typeof TABS)[number];

// Compute 400s with { error: 'invalid_params', detail: [{ strategyId,
// field, message }] } when a selected strategy is missing required
// params — render each row as prose, never the raw code.
function computeErrorMessage(
  err: unknown,
  strategies: Array<{ id: string; name: string }>,
): string {
  if (err instanceof ApiError && err.status === 400) {
    const body = err.body as { error?: string; detail?: unknown } | null;
    if (body?.error === 'invalid_params' && Array.isArray(body.detail)) {
      const names = new Map(strategies.map((s) => [s.id, s.name]));
      const rows = body.detail as Array<{ strategyId: string; field: string; message: string }>;
      const lines = rows.map((d) => {
        const name = names.get(d.strategyId) ?? d.strategyId;
        const msg =
          d.message === 'required parameter missing'
            ? `${d.field} is required`
            : `${d.field} ${d.message}`;
        return `${name}: ${msg}`;
      });
      return `Cannot compute — fix strategy parameters first.\n${lines.join('\n')}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function PlanDetailPage() {
  const { planId, tab } = useParams<{ planId: string; tab?: string }>();
  const qc = useQueryClient();
  const activeTab: PlanTab = TABS.includes(tab as PlanTab) ? (tab as PlanTab) : 'profile';
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<PlanDetail>({
    queryKey: ['plan', planId],
    queryFn: () => api(`/api/planning/plans/${planId}`),
    enabled: Boolean(planId),
  });

  // Same key StrategiesTab populates — cache-shared, so opening the
  // strategies tab first costs nothing extra. Needed here to name
  // strategies in compute invalid_params errors.
  const { data: strategyData } = useQuery<{ strategies: Array<{ id: string; name: string }> }>({
    queryKey: ['planning-strategies'],
    queryFn: () => api('/api/planning/strategies'),
  });

  // A selection PATCH in flight means compute would run stale selections.
  const pendingScenarioSaves = useIsMutating({ mutationKey: ['scenario-save', planId] });

  const compute = useMutation({
    mutationFn: () => api(`/api/planning/plans/${planId}/compute`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plan', planId] });
    },
    onError: (err) => setError(computeErrorMessage(err, strategyData?.strategies ?? [])),
  });

  if (isLoading) return <div className="p-8 text-ink/50">Loading…</div>;
  if (!data) return <div className="p-8 text-ink/50">Plan not found.</div>;
  const { plan } = data;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 max-w-5xl">
      <div className="text-xs text-ink/40 mb-1">
        <Link to="/planning" className="hover:underline">
          Planning
        </Link>{' '}
        / {plan.title}
      </div>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="font-display text-3xl">{plan.title}</h1>
          <div className="text-sm text-ink/60">
            {plan.years}-year window · {plan.status} · engine {plan.engine_version}
          </div>
        </div>
        <button
          onClick={() => {
            // Live check, not render-time state: the click that triggers a
            // param field's blur-save lands before this button re-renders
            // as disabled.
            if (qc.isMutating({ mutationKey: ['scenario-save', planId] }) > 0) return;
            compute.mutate();
          }}
          disabled={compute.isPending || pendingScenarioSaves > 0}
          title={pendingScenarioSaves > 0 ? 'Saving scenario changes…' : undefined}
          className="shrink-0 px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {compute.isPending ? 'Computing…' : 'Compute'}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm mb-3 whitespace-pre-wrap">{error}</div>}

      <nav className="flex gap-1 border-b border-ink/10 mb-4 text-sm">
        {TABS.map((t) => (
          <NavLink
            key={t}
            to={`/planning/${plan.id}/${t}`}
            replace
            className={() =>
              `px-3 py-1.5 capitalize border-b-2 -mb-px ${
                activeTab === t
                  ? 'border-ink font-medium'
                  : 'border-transparent text-ink/50 hover:text-ink'
              }`
            }
          >
            {t}
          </NavLink>
        ))}
      </nav>

      {activeTab === 'profile' && <ProfileTab detail={data} />}
      {activeTab === 'strategies' && <StrategiesTab detail={data} />}
      {activeTab === 'results' && <ScenarioCompare detail={data} />}
      {activeTab === 'review' && <ReviewTab detail={data} />}
      {activeTab === 'deliverables' && <DeliverablesTab detail={data} />}
    </div>
  );
}
