// TP-6 — strategy picker: published strategies with suggest badges, a
// param form generated from each strategy's inputs schema, and per-
// scenario selection editing.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StrategySelection } from '@vibe/shared';
import { api, ApiError } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';

interface ParamError {
  strategyId: string;
  field: string;
  message: string;
}

// Server 400 shape for schema-required params that are missing/invalid.
function parseInvalidParams(err: unknown): ParamError[] | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const body = err.body as { error?: string; detail?: unknown } | null;
  if (!body || body.error !== 'invalid_params' || !Array.isArray(body.detail)) return null;
  return body.detail as ParamError[];
}

// A required param counts as unset when it was never entered or was
// cleared — 0 and false are deliberate values.
function isEmptyParam(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

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
  const [paramErrors, setParamErrors] = useState<ParamError[]>([]);

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
      setParamErrors([]);
      qc.invalidateQueries({ queryKey: ['plan', plan.id] });
    },
    onError: (err) => {
      const detail = parseInvalidParams(err);
      if (detail) {
        setParamErrors(detail);
        setError(null);
      } else {
        setError((err as Error).message);
      }
    },
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
          const required = new Set(s.inputsSchema?.required ?? []);
          const missingRequired = isSelected
            ? Array.from(required).filter((k) => isEmptyParam(selected.get(s.id)?.params[k]))
            : [];
          const serverErrors = paramErrors.filter((e) => e.strategyId === s.id);
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
                          required={required.has(key)}
                          value={selected.get(s.id)?.params[key]}
                          onChange={(v) => setParam(s, key, v)}
                        />
                      ))}
                    </div>
                  )}
                  {missingRequired.length > 0 && (
                    <div className="mt-2 text-xs text-oxblood bg-oxblood/5 border border-oxblood/20 rounded px-2 py-1">
                      Required parameter{missingRequired.length > 1 ? 's' : ''} missing:{' '}
                      {missingRequired.join(', ')}
                    </div>
                  )}
                  {serverErrors.length > 0 && (
                    <ul className="mt-2 text-xs text-oxblood bg-oxblood/5 border border-oxblood/20 rounded px-2 py-1 space-y-0.5">
                      {serverErrors.map((e, i) => (
                        <li key={i}>
                          <span className="font-mono">{e.field}</span>: {e.message}
                        </li>
                      ))}
                    </ul>
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
  required,
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
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const labelText = (
    <>
      {name}
      {required && (
        <span className="text-oxblood" title="Required">
          {' '}
          *
        </span>
      )}
    </>
  );
  const label = (
    <span className="text-xs text-ink/60 block" title={prop.description}>
      {labelText}
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
        <span className="text-xs text-ink/60">{labelText}</span>
      </label>
    );
  }
  return (
    <label className="block">
      {label}
      <NumberParamInput
        value={value}
        minimum={prop.minimum}
        maximum={prop.maximum}
        onCommit={onChange}
      />
    </label>
  );
}

// Number params buffer keystrokes locally and PATCH once on blur —
// mutating per keystroke raced concurrent PATCHes and let a slow early
// response clobber a later value.
function NumberParamInput({
  value,
  minimum,
  maximum,
  onCommit,
}: {
  value: unknown;
  minimum?: number;
  maximum?: number;
  onCommit: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState(value === undefined || value === null ? '' : String(value));
  useEffect(() => {
    setDraft(value === undefined || value === null ? '' : String(value));
  }, [value]);
  return (
    <input
      type="number"
      value={draft}
      min={minimum}
      max={maximum}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft === '' ? undefined : Number(draft);
        if (next !== (value as number | undefined)) onCommit(next);
      }}
      className="mt-0.5 w-full px-2 py-1 border border-ink/20 rounded text-sm"
    />
  );
}
