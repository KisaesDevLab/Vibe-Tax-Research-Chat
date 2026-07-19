// TP-3 — client list: debounced search + create dialog.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../../lib/api';

const ENTITY_TYPES = [
  'individual',
  's-corp',
  'partnership',
  'c-corp',
  'sole-prop',
  'trust',
  'nonprofit',
  'other',
];

export function ClientsPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: debounced }],
    queryFn: () => api(`/api/clients?q=${encodeURIComponent(debounced)}`),
  });

  const rows = data?.clients ?? [];

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-display text-3xl">Clients</h1>
        <button
          onClick={() => setShowNew(true)}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
        >
          + New client
        </button>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name…"
        className="w-full md:w-80 px-3 py-2 border border-ink/20 rounded text-sm mb-4"
      />
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          {debounced ? 'No clients match your search.' : 'No clients yet — create the first one.'}
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Entity type</th>
              <th className="py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-ink/5 hover:bg-ink/5">
                <td className="py-2 pr-4">
                  <Link to={`/clients/${c.id}`} className="hover:underline">
                    {c.name}
                  </Link>
                </td>
                <td className="py-2 pr-4 text-ink/60">{c.entity_type}</td>
                <td className="py-2 text-ink/60">{new Date(c.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showNew && <NewClientDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewClientDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('individual');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ client: ClientDTO }>('/api/clients', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), entity_type: entityType }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded shadow-xl p-6 w-full max-w-md">
        <h2 className="font-display text-xl mb-4">New client</h2>
        <label className="block text-sm mb-3">
          <span className="text-ink/60">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-ink/20 rounded text-sm"
          />
        </label>
        <label className="block text-sm mb-4">
          <span className="text-ink/60">Entity type</span>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-ink/20 rounded text-sm bg-white"
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-ink/20 rounded text-sm">
            Cancel
          </button>
          <button
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
