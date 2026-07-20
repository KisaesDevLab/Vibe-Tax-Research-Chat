// Strategy library management: the full registry (retired included),
// retire/reactivate soft-removal, and the authoring-pipeline triggers
// (per-strategy redraft + full refresh sweep). Content changes still
// flow draft → validators → Review queue — nothing edits prose here.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface StrategyRow {
  id: string;
  name: string;
  category: string | null;
  modeled: boolean;
  riskRating: string | null;
  complexity: number | null;
  semver: string | null;
  version_status: string | null;
  authored_by: string | null;
  retired_at: string | null;
  open_draft: boolean;
}

export function AdminStrategiesPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const { data, isLoading } = useQuery<{ strategies: StrategyRow[] }>({
    queryKey: ['admin', 'strategies'],
    queryFn: () => api('/api/admin/strategies'),
  });

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'retire' | 'reactivate' }) =>
      api(`/api/admin/strategies/${id}/${action}`, { method: 'POST' }),
    onSuccess: (_d, vars) => {
      setError(null);
      setNotice(vars.action === 'retire' ? `Retired ${vars.id}.` : `Reactivated ${vars.id}.`);
      qc.invalidateQueries({ queryKey: ['admin', 'strategies'] });
      // The planning picker caches the active list.
      qc.invalidateQueries({ queryKey: ['planning-strategies'] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const redraft = useMutation({
    mutationFn: (id: string) => api(`/api/admin/strategies/${id}/draft`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      setError(null);
      setNotice(`Redraft queued for ${id} — it will appear in the Review queue.`);
      qc.invalidateQueries({ queryKey: ['admin', 'strategies'] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const sweep = useMutation({
    mutationFn: () => api('/api/admin/strategies/refresh-sweep', { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      setNotice('Refresh sweep queued — drafts land in the Review queue as they complete.');
    },
    onError: (err) => setError((err as Error).message),
  });

  const rows = (data?.strategies ?? []).filter(
    (r) =>
      !filter ||
      String(r.name).toLowerCase().includes(filter.toLowerCase()) ||
      r.id.includes(filter.toLowerCase()) ||
      (r.category ?? '').toLowerCase().includes(filter.toLowerCase()),
  );
  const retiredCount = (data?.strategies ?? []).filter((r) => r.retired_at).length;

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="font-display text-3xl">Strategies</h1>
        <button
          onClick={() => sweep.mutate()}
          disabled={sweep.isPending}
          title="Queue a Claude redraft of every active strategy (needs an API key configured)"
          className="shrink-0 px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {sweep.isPending ? 'Queuing…' : 'Refresh sweep'}
        </button>
      </div>
      <p className="text-sm text-ink/60 mb-4 max-w-2xl">
        The strategy library. Retiring removes a strategy from the picker, suggestions, and the
        refresh sweep — plans that already selected it keep computing their pinned version. Content
        changes go through the pipeline: request a redraft and decide it in the Review queue.
      </p>
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
      {notice && !error && <div className="text-moss text-sm mb-3">{notice}</div>}
      <div className="flex items-center gap-3 mb-4">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, id, or category…"
          className="border border-ink/20 rounded px-3 py-1.5 text-sm w-72 bg-paper"
        />
        <span className="text-xs text-ink/40">
          {data?.strategies.length ?? 0} strategies · {retiredCount} retired
        </span>
      </div>
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          {filter ? 'No strategies match the filter.' : 'No strategies — re-run the seed.'}
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Strategy</th>
              <th className="py-2 pr-4">Category</th>
              <th className="py-2 pr-4">Risk</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Version</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-ink/5 ${r.retired_at ? 'opacity-50' : ''}`}
              >
                <td className="py-2 pr-4">
                  <div className="font-medium">{r.name}</div>
                  <div className="text-[11px] text-ink/40">{r.id}</div>
                </td>
                <td className="py-2 pr-4">{r.category ?? '—'}</td>
                <td className="py-2 pr-4 capitalize">{r.riskRating ?? '—'}</td>
                <td className="py-2 pr-4">{r.modeled ? 'Modeled' : 'Advisory'}</td>
                <td className="py-2 pr-4">{r.semver ?? '—'}</td>
                <td className="py-2 pr-4">
                  {r.retired_at ? (
                    <span className="text-oxblood">retired</span>
                  ) : r.open_draft ? (
                    <span className="text-gold">draft in review</span>
                  ) : (
                    <span className="text-moss">active</span>
                  )}
                </td>
                <td className="py-2 text-right whitespace-nowrap">
                  {!r.retired_at && (
                    <button
                      onClick={() => redraft.mutate(r.id)}
                      disabled={redraft.isPending || r.open_draft}
                      title={
                        r.open_draft
                          ? 'A draft is already open in the Review queue'
                          : 'Queue a Claude redraft (needs an API key configured)'
                      }
                      className="px-2 py-1 text-xs border border-ink/20 rounded hover:bg-ink/5 disabled:opacity-40 mr-2"
                    >
                      Redraft
                    </button>
                  )}
                  {r.retired_at ? (
                    <button
                      onClick={() => act.mutate({ id: r.id, action: 'reactivate' })}
                      disabled={act.isPending}
                      className="px-2 py-1 text-xs border border-ink/20 rounded hover:bg-ink/5 disabled:opacity-40"
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            `Retire “${r.name}”? It disappears from the picker and suggestions; existing plans keep computing.`,
                          )
                        ) {
                          act.mutate({ id: r.id, action: 'retire' });
                        }
                      }}
                      disabled={act.isPending}
                      className="px-2 py-1 text-xs border border-oxblood/40 text-oxblood rounded hover:bg-oxblood/5 disabled:opacity-40"
                    >
                      Retire
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
