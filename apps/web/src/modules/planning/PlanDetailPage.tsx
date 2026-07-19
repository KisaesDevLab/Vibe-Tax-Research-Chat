// TP-6 — plan detail: Profile (JSON editor until the TP-7 typed intake
// form) · Strategies (picker with suggest badges + schema-driven param
// forms) · Results (baseline vs scenario compare).
import { useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanDTO, PlanScenarioDTO, PlanResultDTO } from '@vibe/shared';
import { api } from '../../lib/api';
import { StrategiesTab } from './StrategiesTab';
import { ScenarioCompare } from './ScenarioCompare';
import { ProfileTab } from './ProfileTab';

export interface PlanDetail {
  plan: PlanDTO;
  scenarios: PlanScenarioDTO[];
  results: PlanResultDTO[];
}

const TABS = ['profile', 'strategies', 'results'] as const;
type PlanTab = (typeof TABS)[number];

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

  const compute = useMutation({
    mutationFn: () => api(`/api/planning/plans/${planId}/compute`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plan', planId] });
    },
    onError: (err) => setError((err as Error).message),
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
          onClick={() => compute.mutate()}
          disabled={compute.isPending}
          className="shrink-0 px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {compute.isPending ? 'Computing…' : 'Compute'}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}

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
    </div>
  );
}
