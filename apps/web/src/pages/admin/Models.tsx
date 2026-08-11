// Phase 6 — model registry editor.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';

interface ModelRow {
  model_id: string;
  display_name: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_write_per_mtok: string;
  cache_read_per_mtok: string;
  tokenizer_factor: string;
  web_fetch_unit_cost: string;
  web_search_unit_cost: string;
  is_active: boolean;
  notes?: string | null;
}

interface DefaultModelSetting {
  key: string;
  value: string | null;
}

export function AdminModelsPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ models: ModelRow[] }>({
    queryKey: ['admin', 'models'],
    queryFn: () => api('/api/admin/models'),
  });
  const { data: defaultSetting } = useQuery<DefaultModelSetting>({
    queryKey: ['admin', 'settings', 'default-model'],
    queryFn: () => api('/api/admin/settings/default_model_id'),
  });
  const defaultId = defaultSetting?.value ?? null;

  // The refresh diff shape; mirrors the server-side response. Source
  // tells us which authority the diff was computed against so the user
  // knows whether to trust `removed[]` (only meaningful when source =
  // 'anthropic' — the bundled / upstream paths can't say what's missing).
  interface RefreshDiff {
    source: 'anthropic' | 'upstream' | 'bundled';
    upstream_error?: string;
    discovery_error?: string;
    added: Array<{
      model_id: string;
      display_name: string;
      pricing_unknown?: boolean;
      input_per_mtok?: number;
      output_per_mtok?: number;
    }>;
    updated: Array<{ model_id: string; before: unknown; after: unknown }>;
    removed: Array<{ model_id: string; display_name: string }>;
    unchanged_count: number;
  }

  const [diff, setDiff] = useState<RefreshDiff | null>(null);
  const refresh = useMutation<RefreshDiff>({
    mutationFn: () => api('/api/admin/models/refresh', { method: 'POST' }),
    onSuccess: (d) => setDiff(d),
    onError: (e) => setError(humanize(e)),
  });
  const apply = useMutation({
    mutationFn: () =>
      api('/api/admin/models/refresh/apply', { method: 'POST', body: JSON.stringify(diff) }),
    onSuccess: () => {
      setDiff(null);
      qc.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  const setDefault = useMutation({
    mutationFn: (model_id: string) =>
      api('/api/admin/settings/default-model', {
        method: 'POST',
        body: JSON.stringify({ model_id }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'settings', 'default-model'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  const toggleActive = useMutation({
    mutationFn: ({ model_id, is_active }: { model_id: string; is_active: boolean }) =>
      api(`/api/admin/models/${encodeURIComponent(model_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'models'] }),
    onError: (e) => setError(humanize(e)),
  });

  // Inline pricing editor — one row at a time. Drafts are strings so
  // partial input ("1.") doesn't fight the number parser while typing.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const savePricing = useMutation({
    mutationFn: ({ model_id, fields }: { model_id: string; fields: Record<string, number> }) =>
      api(`/api/admin/models/${encodeURIComponent(model_id)}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  const PRICE_FIELDS = [
    ['input_per_mtok', 'Input $/Mtok'],
    ['output_per_mtok', 'Output $/Mtok'],
    ['cache_write_per_mtok', 'Cache write $/Mtok'],
    ['cache_read_per_mtok', 'Cache read $/Mtok'],
  ] as const;

  function startEdit(m: ModelRow) {
    setEditing(m.model_id);
    setDraft({
      input_per_mtok: m.input_per_mtok,
      output_per_mtok: m.output_per_mtok,
      cache_write_per_mtok: m.cache_write_per_mtok,
      cache_read_per_mtok: m.cache_read_per_mtok,
    });
  }

  function submitEdit(model_id: string) {
    const fields: Record<string, number> = {};
    for (const [key] of PRICE_FIELDS) {
      const n = Number(draft[key]);
      if (!Number.isFinite(n) || n < 0) {
        setError(`Invalid value for ${key} — enter a non-negative number.`);
        return;
      }
      fields[key] = n;
    }
    savePricing.mutate({ model_id, fields });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Models</h1>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="px-3 py-1.5 border border-ink/20 rounded text-sm disabled:opacity-50"
          title="Calls Anthropic /v1/models with your stored API key; falls back to the bundled pricing seed if the call fails"
        >
          {refresh.isPending ? 'Checking Anthropic…' : 'Check Anthropic for new models'}
        </button>
      </div>

      {error && (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4 flex items-baseline justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline whitespace-nowrap">
            Dismiss
          </button>
        </div>
      )}

      {diff !== null && (
        <div className="mb-6 border border-gold/40 bg-gold/5 p-4 rounded">
          <div className="flex items-baseline justify-between mb-2">
            <div className="font-display text-lg">Pending changes</div>
            <SourceBadge diff={diff} />
          </div>
          {diff.discovery_error && (
            <div className="text-xs text-ink/70 mb-2">
              Anthropic API discovery failed:{' '}
              <span className="font-mono">{diff.discovery_error}</span>.
              {diff.discovery_error === 'anthropic_api_key_not_set' ? (
                <>
                  {' '}
                  Set the API key under <strong>Admin → Settings</strong> to enable live model
                  discovery.
                </>
              ) : diff.discovery_error === 'no_models_available_for_api_key' ? (
                <>
                  {' '}
                  Your API key has no models available — confirm it's still active and provisioned.
                </>
              ) : (
                <>
                  {' '}
                  Showing diff against the {diff.source === 'upstream'
                    ? 'upstream'
                    : 'bundled'}{' '}
                  pricing manifest only — DB rows are not flagged as removed in this mode.
                </>
              )}
            </div>
          )}
          {diff.added.some((a) => a.pricing_unknown) && (
            <div className="border border-gold/40 bg-gold/5 text-ink/80 text-xs rounded p-2 mb-2">
              <strong>New models without pricing:</strong> some added models were discovered via the
              Anthropic API but have no entry in the pricing manifest. They will be added{' '}
              <strong>inactive</strong> — set their pricing in the table below, then enable them.
            </div>
          )}
          <pre className="font-mono text-xs overflow-auto max-h-64">
            {JSON.stringify(diff, null, 2)}
          </pre>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => apply.mutate()}
              disabled={apply.isPending}
              className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
            >
              {apply.isPending ? 'Applying…' : 'Apply'}
            </button>
            <button onClick={() => setDiff(null)} className="px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
            <th className="py-2">Model</th>
            <th>Input $/Mtok</th>
            <th>Output $/Mtok</th>
            <th>Cache W</th>
            <th>Cache R</th>
            <th>Tokenizer</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.models.map((m) => {
            const isDefault = defaultId === m.model_id;
            const isEditing = editing === m.model_id;
            if (isEditing) {
              return (
                <tr key={m.model_id} className="border-b border-ink/5 bg-gold/5">
                  <td className="py-2">
                    <span>{m.display_name}</span>
                    <div className="font-mono text-xs text-ink/50">{m.model_id}</div>
                  </td>
                  {PRICE_FIELDS.map(([key, label]) => (
                    <td key={key} className="pr-2">
                      <input
                        value={draft[key] ?? ''}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                        aria-label={`${m.model_id} ${label}`}
                        className="w-20 font-mono text-xs border border-ink/20 rounded px-1.5 py-1"
                      />
                    </td>
                  ))}
                  <td className="font-mono">{m.tokenizer_factor}</td>
                  <td>{m.is_active ? 'yes' : 'no'}</td>
                  <td>
                    <div className="flex gap-3 justify-end whitespace-nowrap">
                      <button
                        onClick={() => submitEdit(m.model_id)}
                        disabled={savePricing.isPending}
                        className="text-xs underline text-moss disabled:opacity-50"
                      >
                        {savePricing.isPending ? 'saving…' : 'save'}
                      </button>
                      <button onClick={() => setEditing(null)} className="text-xs underline">
                        cancel
                      </button>
                    </div>
                  </td>
                </tr>
              );
            }
            return (
              <tr key={m.model_id} className="border-b border-ink/5">
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <span>{m.display_name}</span>
                    {isDefault && (
                      <span className="text-[10px] uppercase tracking-wider bg-moss/15 text-moss px-1.5 py-0.5 rounded">
                        default
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-ink/50">{m.model_id}</div>
                </td>
                <td className="font-mono">{m.input_per_mtok}</td>
                <td className="font-mono">{m.output_per_mtok}</td>
                <td className="font-mono">{m.cache_write_per_mtok}</td>
                <td className="font-mono">{m.cache_read_per_mtok}</td>
                <td className="font-mono">{m.tokenizer_factor}</td>
                <td>{m.is_active ? 'yes' : 'no'}</td>
                <td>
                  <div className="flex gap-3 justify-end whitespace-nowrap">
                    <button onClick={() => startEdit(m)} className="text-xs underline">
                      edit pricing
                    </button>
                    {!isDefault && m.is_active && (
                      <button
                        onClick={() => setDefault.mutate(m.model_id)}
                        className="text-xs underline"
                      >
                        set default
                      </button>
                    )}
                    {m.is_active ? (
                      <button
                        onClick={() =>
                          toggleActive.mutate({ model_id: m.model_id, is_active: false })
                        }
                        className="text-xs underline text-oxblood"
                      >
                        disable
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          toggleActive.mutate({ model_id: m.model_id, is_active: true })
                        }
                        className="text-xs underline text-moss"
                      >
                        enable
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function humanize(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === 'cannot_disable_default_model')
      return "Can't disable the active default — pick another default first.";
    if (e.message === 'unknown_or_inactive_model')
      return 'That model is unknown or inactive — enable it first or pick another.';
    if (e.message === 'manifest_unavailable')
      return 'Upstream manifest unreachable; the bundled fallback also failed.';
    if (e.message === 'pricing_required_to_activate')
      return 'This model still has $0 pricing — use "edit pricing" to set real rates first.';
    if (e.message === 'pricing_required') {
      const detail = (e as ApiError & { body?: { detail?: string } }).body?.detail;
      return detail
        ? `Pricing required: ${detail}`
        : 'Some added models need pricing before they can be applied.';
    }
    return e.message;
  }
  return (e as Error).message;
}

function SourceBadge({ diff }: { diff: { source: 'anthropic' | 'upstream' | 'bundled' } }) {
  const labels: Record<typeof diff.source, { text: string; cls: string }> = {
    anthropic: {
      text: 'live from Anthropic',
      cls: 'bg-moss/15 text-moss',
    },
    upstream: {
      text: 'pricing manifest (CDN)',
      cls: 'bg-gold/15 text-ink/70',
    },
    bundled: {
      text: 'pricing manifest (bundled)',
      cls: 'bg-ink/10 text-ink/60',
    },
  };
  const l = labels[diff.source];
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${l.cls}`}>
      {l.text}
    </span>
  );
}
