// Phase 6 — model registry editor.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';

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

export function AdminModelsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<{ models: ModelRow[] }>({
    queryKey: ['admin', 'models'],
    queryFn: () => api('/api/admin/models'),
  });

  const [diff, setDiff] = useState<unknown>(null);
  const refresh = useMutation({
    mutationFn: () => api('/api/admin/models/refresh', { method: 'POST' }),
    onSuccess: (d) => setDiff(d),
  });
  const apply = useMutation({
    mutationFn: () =>
      api('/api/admin/models/refresh/apply', { method: 'POST', body: JSON.stringify(diff) }),
    onSuccess: () => {
      setDiff(null);
      qc.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
  });

  const setDefault = useMutation({
    mutationFn: (model_id: string) =>
      api('/api/admin/settings/default-model', {
        method: 'POST',
        body: JSON.stringify({ model_id }),
      }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Models</h1>
        <button onClick={() => refresh.mutate()} className="px-3 py-1.5 border border-ink/20 rounded text-sm">
          Refresh from upstream
        </button>
      </div>

      {diff !== null && (
        <div className="mb-6 border border-gold/40 bg-gold/5 p-4 rounded">
          <div className="font-display text-lg mb-2">Pending changes</div>
          <pre className="font-mono text-xs overflow-auto max-h-64">{JSON.stringify(diff, null, 2)}</pre>
          <div className="flex gap-2 mt-2">
            <button onClick={() => apply.mutate()} className="px-3 py-1.5 bg-ink text-paper rounded text-sm">
              Apply
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
          {data?.models.map((m) => (
            <tr key={m.model_id} className="border-b border-ink/5">
              <td className="py-2">
                <div>{m.display_name}</div>
                <div className="font-mono text-xs text-ink/50">{m.model_id}</div>
              </td>
              <td className="font-mono">{m.input_per_mtok}</td>
              <td className="font-mono">{m.output_per_mtok}</td>
              <td className="font-mono">{m.cache_write_per_mtok}</td>
              <td className="font-mono">{m.cache_read_per_mtok}</td>
              <td className="font-mono">{m.tokenizer_factor}</td>
              <td>{m.is_active ? 'yes' : 'no'}</td>
              <td>
                <button
                  onClick={() => setDefault.mutate(m.model_id)}
                  className="text-xs underline"
                >
                  set default
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
