// TP-6 — strategy picker: published strategies with suggest badges, a
// param form generated from each strategy's inputs schema, and per-
// scenario selection editing.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useIsFetching,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { StrategySelection } from '@vibe/shared';
import { api, ApiError } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';
import { SuggestedStrategiesPanel } from './SuggestedStrategiesPanel';

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

  // Authoritative selections live in local state (mirrored in a ref for
  // synchronous reads) — rebuilding each PATCH from the query cache raced
  // quick blur-commits: the second PATCH omitted the first's not-yet-
  // refetched value and the input visibly reverted. Server data is
  // reconciled in only when no save or plan refetch is in flight.
  const [localSelections, setLocalSelections] = useState<StrategySelection[]>(
    () => scenario?.selections ?? [],
  );
  const selectionsRef = useRef(localSelections);
  const pendingSaves = useIsMutating({ mutationKey: ['scenario-save', plan.id] });
  const planFetching = useIsFetching({ queryKey: ['plan', plan.id] });
  const serverSelections = scenario?.selections;
  // Reconciliation is per-strategy: entries whose params were rejected
  // keep their local (rejected-but-visible) value so the error message
  // still describes what's on screen; everything else takes the server
  // state. A whole-array hold would silently freeze OTHER strategies'
  // edits out of the server round-trip.
  const erroredIds = useMemo(() => new Set(paramErrors.map((e) => e.strategyId)), [paramErrors]);
  // Last selections the server ACCEPTED — updated synchronously on save
  // success, unlike the query cache, which lags until the invalidated
  // refetch lands. Substituting held entries from the cache could ship a
  // stale pre-edit value and regress a param the server already has.
  const lastPersistedRef = useRef<StrategySelection[]>(scenario?.selections ?? []);
  useEffect(() => {
    if (pendingSaves === 0 && planFetching === 0 && serverSelections) {
      lastPersistedRef.current = serverSelections;
      const local = new Map(selectionsRef.current.map((s) => [s.strategyId, s]));
      const next = serverSelections.map((s) =>
        erroredIds.has(s.strategyId) ? (local.get(s.strategyId) ?? s) : s,
      );
      selectionsRef.current = next;
      setLocalSelections(next);
    }
  }, [serverSelections, pendingSaves, planFetching, erroredIds]);

  const { data } = useQuery<{ strategies: StrategyListing[] }>({
    queryKey: ['planning-strategies'],
    queryFn: () => api('/api/planning/strategies'),
  });
  const { data: suggestData } = useQuery<import('@vibe/shared').SuggestResponse>({
    queryKey: ['plan-suggestions', plan.id, plan.updated_at],
    queryFn: () =>
      api('/api/planning/strategies/suggest', {
        method: 'POST',
        // TP-5a: server loads the profile AND the plan's fact snapshot.
        body: JSON.stringify({ plan_id: plan.id }),
      }),
  });
  const suggestions = new Map(
    (suggestData?.suggestions ?? [])
      .filter((s) => s.status !== 'excluded')
      .map((s) => [s.strategyId, s]),
  );

  const save = useMutation({
    mutationKey: ['scenario-save', plan.id],
    mutationFn: (vars: { selections: StrategySelection[]; heldIds: string[] }) =>
      api(`/api/planning/plans/${plan.id}/scenarios/${scenario!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ selections: vars.selections }),
      }),
    onSuccess: (_data, vars) => {
      setError(null);
      lastPersistedRef.current = vars.selections;
      // Only errors for strategies whose local value actually SHIPPED are
      // resolved. Held strategies were substituted with their last-good
      // entry — their rejected value is still on screen and its error
      // must survive an unrelated edit's successful save.
      setParamErrors((prev) => prev.filter((e) => vars.heldIds.includes(e.strategyId)));
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
  const selected = new Map(localSelections.map((s) => [s.strategyId, s]));
  const strategies = data?.strategies ?? [];

  // Every commit updates the ref synchronously and PATCHes that exact
  // array — never a rebuild from the (possibly stale) query cache. In
  // the PAYLOAD, a strategy whose params were rejected reverts to its
  // last-ACCEPTED entry (lastPersistedRef, not the laggy query cache):
  // sending the known-bad value again would 400 the whole array and
  // silently drop the unrelated edit being saved.
  function commit(next: StrategySelection[], clearedErrorId?: string) {
    selectionsRef.current = next;
    setLocalSelections(next);
    const persisted = new Map(lastPersistedRef.current.map((s) => [s.strategyId, s]));
    const heldIds: string[] = [];
    const payload = next.map((s) => {
      // clearedErrorId: setParam just replaced that strategy's rejected
      // value — its NEW input must ship, not the last-good entry
      // (state updates land after this synchronous commit).
      if (erroredIds.has(s.strategyId) && s.strategyId !== clearedErrorId) {
        const lastGood = persisted.get(s.strategyId);
        // No last-good entry means the local value ships after all — if
        // the server then accepts it, its error must clear, so it is
        // NOT held.
        if (lastGood) {
          heldIds.push(s.strategyId);
          return lastGood;
        }
      }
      return s;
    });
    save.mutate({ selections: payload, heldIds });
  }

  function toggle(s: StrategyListing) {
    const next = new Map(selectionsRef.current.map((x) => [x.strategyId, x]));
    if (next.has(s.id)) next.delete(s.id);
    else next.set(s.id, { strategyId: s.id, version: s.semver, params: {} });
    commit(Array.from(next.values()));
  }

  function setParam(s: StrategyListing, key: string, value: unknown) {
    const cur = selectionsRef.current;
    if (!cur.some((x) => x.strategyId === s.id)) return;
    setParamErrors((prev) => prev.filter((e) => e.strategyId !== s.id));
    commit(
      cur.map((x) => (x.strategyId === s.id ? { ...x, params: { ...x.params, [key]: value } } : x)),
      s.id,
    );
  }

  return (
    <div className="max-w-3xl">
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
      <SuggestedStrategiesPanel
        planId={plan.id}
        suggestData={suggestData}
        strategies={strategies.map((s) => ({ id: s.id, name: s.name, modeled: s.modeled }))}
      />
      <div className="text-sm text-ink/60 mb-3">
        Scenario “{scenario.label}” — {localSelections.length} strategy(ies) selected. Suggested
        strategies are badged from the profile and fact-pattern rules.
      </div>
      <ul className="space-y-2">
        {strategies.map((s) => {
          const isSelected = selected.has(s.id);
          const suggestion = suggestions.get(s.id);
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
                    {suggestion?.status === 'matched' && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gold/20 text-ink/70"
                        title={suggestion.reason}
                      >
                        suggested
                      </span>
                    )}
                    {suggestion?.status === 'toConfirm' && (
                      <span
                        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-gold/60 text-gold"
                        title={suggestion.toConfirm.join('; ')}
                      >
                        confirm facts
                      </span>
                    )}
                  </div>
                  {suggestion && suggestion.reason && (
                    <div className="text-xs text-ink/50 mt-0.5">{suggestion.reason}</div>
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
                          profile={plan.baseline_profile}
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
  profile,
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
  profile: {
    rentals: Array<{ id: string; name: string }>;
    businesses: Array<{ id: string; name: string }>;
  };
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
  // Params that reference a profile entity (rentalId → the plan's
  // rentals, businessId → its businesses) are pickers over the entities
  // that actually exist — hand-typing an internal id is unguessable and
  // the apply module refuses unknown ids rather than silently
  // retargeting.
  const entityOptions =
    name === 'rentalId' ? profile.rentals : name === 'businessId' ? profile.businesses : null;
  if (entityOptions) {
    const entityNoun = name === 'rentalId' ? 'rental' : 'business';
    return (
      <label className="block">
        {label}
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full px-2 py-1 border border-ink/20 rounded text-sm bg-white"
        >
          <option value="" disabled>
            {entityOptions.length === 0
              ? `no ${entityNoun}s on the profile — add one in the Profile tab`
              : `select a ${entityNoun}…`}
          </option>
          {entityOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  // Plain string params are free text — the numeric input below would
  // coerce them to numbers and the server would reject the type.
  if (prop.type === 'string') {
    return (
      <label className="block">
        {label}
        <input
          type="text"
          defaultValue={value === undefined || value === null ? '' : String(value)}
          onBlur={(e) => {
            const v = e.target.value.trim();
            onChange(v === '' ? undefined : v);
          }}
          className="mt-0.5 w-full px-2 py-1 border border-ink/20 rounded text-sm bg-white"
        />
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
