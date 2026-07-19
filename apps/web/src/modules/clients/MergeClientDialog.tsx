// TP-3 — merge this client into another. The source record is marked
// merged (hidden from lists) and its links move to the survivor.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../../lib/api';
import { useActiveClient } from '../../lib/active-client';

export function MergeClientDialog({ client, onClose }: { client: ClientDTO; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { activeClient, setActiveClient } = useActiveClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [target, setTarget] = useState<ClientDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: debounced }],
    queryFn: () => api(`/api/clients?q=${encodeURIComponent(debounced)}`),
  });

  const merge = useMutation({
    mutationFn: () =>
      api(`/api/clients/${client.id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ into_client_id: target!.id }),
      }),
    onSuccess: () => {
      if (activeClient?.id === client.id && target) {
        setActiveClient({ id: target.id, name: target.name });
      }
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['client', target!.id] });
      navigate(`/clients/${target!.id}`);
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  const candidates = (data?.clients ?? []).filter((c) => c.id !== client.id);

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded shadow-xl p-6 w-full max-w-md">
        <h2 className="font-display text-xl mb-1">Merge “{client.name}”</h2>
        <p className="text-sm text-ink/60 mb-4">
          Its research chats and archives move to the surviving client. This record stays as a
          hidden pointer so old links keep working. This cannot be undone.
        </p>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search for the surviving client…"
          className="w-full px-3 py-2 border border-ink/20 rounded text-sm mb-2"
        />
        <div className="max-h-56 overflow-y-auto border border-ink/10 rounded mb-4">
          {candidates.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink/40">No other clients found.</div>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setTarget(c)}
                className={`block w-full text-left px-3 py-2 text-sm hover:bg-ink/5 ${
                  target?.id === c.id ? 'bg-ink/10' : ''
                }`}
              >
                {c.name}
                <span className="text-ink/40 ml-2 text-xs">{c.entity_type}</span>
              </button>
            ))
          )}
        </div>
        {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 border border-ink/20 rounded text-sm">
            Cancel
          </button>
          <button
            disabled={!target || merge.isPending}
            onClick={() => merge.mutate()}
            className="px-3 py-1.5 bg-oxblood text-paper rounded text-sm disabled:opacity-50"
          >
            {merge.isPending ? 'Merging…' : target ? `Merge into ${target.name}` : 'Merge'}
          </button>
        </div>
      </div>
    </div>
  );
}
