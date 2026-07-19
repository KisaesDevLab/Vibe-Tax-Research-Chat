// TP-6 — strategy picker: published strategies with suggest badges, a
// param form generated from each strategy's inputs schema, and per-
// scenario selection editing.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StrategySelection } from '@vibe/shared';
import { api } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';

interface StrategyListing {
  id: string;
  semver: string;
  name: string;
  category: string;
  modeled: boolean;
  complexity: number;
  riskRating: 'low' | 'moderate' | 'elevated';
  typicalSavingsBand: string;
  inputsSchema: {
    properties?: Record<
      string,
      { type?: string; enum?: string[]; minimum?: number; maximum?: number; description?: string }
    >;
    required?: string[];
  } | null;
  applyOrder: number | null;
}

export function StrategiesTab({ detail }: { detail: PlanDetail }) {
  const { plan, scenarios } = detail;
  const qc = useQueryClient();
  const scenario = scenarios[0] ?? null;
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<{ strategies: StrategyListing[] }>({
    queryKey: ['planning-strategies'],
    queryFn: () => api('/api/planning/strategies'),
  });
  const { data: suggestData } = useQuery<{
    suggestions: Array<{ strategyId: string; reason: string }>;
  }>({
    queryKey: ['plan-suggestions', plan.id, plan.updated_at],
    queryFn: () =>
      api('/api/planning/strategies/suggest', {
        method: 'POST',
        body: JSON.stringify({ profile: plan.baseline_profile }),
      }),
  });
  const suggestions = new Map(
    (suggestData?.suggestions ?? []).map((s) => [s.strategyId, s.reason]),
  );

  const save = useMutation({
    mutationFn: (selections: StrategySelection[]) =>
      api(`/api/planning/plans/${plan.id}/scenarios/${scenario!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ selections }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plan', plan.id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  if (!scenario) return <div className="text-ink/50">No scenario on this plan.</div>;
  const selected = new Map(scenario.selections.map((s) => [s.strategyId, s]));
  const strategies = data?.strategies ?? [];

  function toggle(s: StrategyListing) {
    const next = new Map(selected);
    if (next.has(s.id)) next.delete(s.id);
    else next.set(s.id, { strategyId: s.id, version: s.semver, params: {} });
    save.mutate(Array.from(next.values()));
  }

  function setParam(s: StrategyListing, key: string, value: unknown) {
    const cur = selected.get(s.id);
    if (!cur) return;
    const next = new Map(selected);
    next.set(s.id, { ...cur, params: { ...cur.params, [key]: value } });
    save.mutate(Array.from(next.values()));
  }

  return (
    <div className="max-w-3xl">
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
      <div className="text-sm text-ink/60 mb-3">
        Scenario “{scenario.label}” — {scenario.selections.length} strategy(ies) selected. Suggested
        strategies are badged from the profile rules.
      </div>
      <ul className="space-y-2">
        {strategies.map((s) => {
          const isSelected = selected.has(s.id);
          const suggestReason = suggestions.get(s.id);
          return (
            <li
              key={s.id}
              className={`border rounded p-3 ${isSelected ? 'border-moss bg-moss/5' : 'border-ink/10 bg-white'}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={isSelected}
                  disabled={!s.modeled}
                  onChange={() => toggle(s)}
                  title={s.modeled ? '' : 'Advisory strategy — no computed savings'}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{s.name}</span>
                    <span className="text-xs text-ink/40">{s.category}</span>
                    {s.riskRating === 'elevated' && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-oxblood/10 text-oxblood">
                        elevated risk
                      </span>
                    )}
                    {!s.modeled && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10 text-ink/50">
                        advisory
                      </span>
                    )}
                    {suggestReason && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gold/20 text-ink/70"
                        title={suggestReason}
                      >
                        suggested
                      </span>
                    )}
                  </div>
                  {suggestReason && (
                    <div className="text-xs text-ink/50 mt-0.5">{suggestReason}</div>
                  )}
                  {isSelected && s.inputsSchema?.properties && (
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {Object.entries(s.inputsSchema.properties).map(([key, prop]) => (
                        <ParamField
                          key={key}
                          name={key}
                          prop={prop}
                          value={selected.get(s.id)?.params[key]}
                          onChange={(v) => setParam(s, key, v)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ParamField({
  name,
  prop,
  value,
  onChange,
}: {
  name: string;
  prop: {
    type?: string;
    enum?: string[];
    description?: string;
    minimum?: number;
    maximum?: number;
  };
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = (
    <span className="text-xs text-ink/60 block" title={prop.description}>
      {name}
    </span>
  );
  if (prop.enum) {
    return (
      <label className="block">
        {label}
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full px-2 py-1 border border-ink/20 rounded text-sm bg-white"
        >
          <option value="" disabled>
            select…
          </option>
          {prop.enum.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (prop.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 mt-4">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-xs text-ink/60">{name}</span>
      </label>
    );
  }
  return (
    <label className="block">
      {label}
      <input
        type="number"
        value={(value as number) ?? ''}
        min={prop.minimum}
        max={prop.maximum}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className="mt-0.5 w-full px-2 py-1 border border-ink/20 rounded text-sm"
      />
    </label>
  );
}
