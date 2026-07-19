// TP-6 — plan list with client filter and new-plan flow (defaults to the
// active-client chip).
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanDTO, ClientDTO } from '@vibe/shared';
import { api } from '../../lib/api';
import { useActiveClient } from '../../lib/active-client';

const STATUS_CLASSES: Record<string, string> = {
  draft: 'bg-ink/10 text-ink/60',
  'in-review': 'bg-gold/20 text-ink/70',
  presented: 'bg-moss/15 text-moss',
  engaged: 'bg-moss/25 text-moss',
  delivered: 'bg-moss/25 text-moss',
  archived: 'bg-ink/10 text-ink/40',
};

export function PlansListPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { activeClient } = useActiveClient();

  const { data, isLoading } = useQuery<{ plans: PlanDTO[] }>({
    queryKey: ['plans'],
    queryFn: () => api('/api/planning/plans'),
  });
  const { data: clientsData } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: '' }],
    queryFn: () => api('/api/clients?q='),
  });
  const clientName = new Map((clientsData?.clients ?? []).map((c) => [c.id, c.name]));

  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api<{ plan: PlanDTO }>('/api/planning/plans', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient!.id }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      navigate(`/planning/${r.plan.id}`);
    },
    onError: (err) => setError((err as Error).message),
  });

  const rows = data?.plans ?? [];

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-3xl">Planning</h1>
        <button
          onClick={() => create.mutate()}
          disabled={!activeClient || create.isPending}
          title={activeClient ? `New plan for ${activeClient.name}` : 'Set an active client first'}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {activeClient ? `+ New plan · ${activeClient.name}` : '+ New plan (set client)'}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          No plans yet. Set an active client (top right) and create the first one.
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Plan</th>
              <th className="py-2 pr-4">Client</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Years</th>
              <th className="py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-ink/5 hover:bg-ink/5">
                <td className="py-2 pr-4">
                  <Link to={`/planning/${p.id}`} className="hover:underline">
                    {p.title}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-ink/60">{clientName.get(p.client_id) ?? '—'}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${STATUS_CLASSES[p.status] ?? ''}`}
                  >
                    {p.status}
                  </span>
                </td>
                <td className="py-2 pr-4 text-ink/60">{p.years}</td>
                <td className="py-2 text-ink/60">{new Date(p.updated_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
