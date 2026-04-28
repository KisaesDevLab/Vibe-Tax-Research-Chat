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

  const [diff, setDiff] = useState<unknown>(null);
  const refresh = useMutation({
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

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Models</h1>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="px-3 py-1.5 border border-ink/20 rounded text-sm disabled:opacity-50"
        >
          {refresh.isPending ? 'Fetching…' : 'Refresh from upstream'}
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
          <div className="font-display text-lg mb-2">Pending changes</div>
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
    return e.message;
  }
  return (e as Error).message;
}
