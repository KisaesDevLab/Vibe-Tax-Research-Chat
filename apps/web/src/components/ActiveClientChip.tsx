// TP-2 — active-client chip in the AppShell header. Sets the app-level
// client context: new research chats soft-link to it, planning will
// default new plans to it. Clearable; never required for research.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../lib/api';
import { useActiveClient } from '../lib/active-client';

export function ActiveClientChip() {
  const { activeClient, setActiveClient } = useActiveClient();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      {activeClient ? (
        <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-moss/10 border border-moss/30 text-sm">
          <button
            type="button"
            className="max-w-[180px] truncate hover:underline"
            title={`Active client: ${activeClient.name}`}
            onClick={() => setOpen((v) => !v)}
          >
            {activeClient.name}
          </button>
          <button
            type="button"
            aria-label="Clear active client"
            className="w-4 h-4 grid place-items-center rounded-full hover:bg-ink/10 text-ink/50"
            onClick={() => setActiveClient(null)}
          >
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-sm px-2 py-0.5 rounded border border-dashed border-ink/25 text-ink/50 hover:text-ink hover:border-ink/50"
        >
          + Client
        </button>
      )}
      {open && (
        <ClientPicker
          onPick={(c) => {
            setActiveClient({ id: c.id, name: c.name });
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ClientPicker({
  onPick,
  onClose,
}: {
  onPick: (client: ClientDTO) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Close on outside click / Escape.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const { data, isLoading } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: debounced }],
    queryFn: () => api(`/api/clients?q=${encodeURIComponent(debounced)}`),
  });

  const createClient = useMutation({
    mutationFn: () =>
      api<{ client: ClientDTO }>('/api/clients', {
        method: 'POST',
        body: JSON.stringify({ name: q.trim() }),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      onPick(r.client);
    },
  });

  const rows = data?.clients ?? [];
  const trimmed = q.trim();
  const exactMatch = rows.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div
      ref={rootRef}
      className="absolute right-0 top-full mt-1 z-40 w-72 bg-white border border-ink/15 rounded shadow-lg p-2"
    >
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search clients…"
        className="w-full px-2 py-1.5 border border-ink/20 rounded text-sm mb-2"
      />
      <div className="max-h-64 overflow-y-auto">
        {isLoading && <div className="px-2 py-1.5 text-sm text-ink/40">Loading…</div>}
        {!isLoading && rows.length === 0 && (
          <div className="px-2 py-1.5 text-sm text-ink/40">No clients found.</div>
        )}
        {rows.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c)}
            className="block w-full text-left px-2 py-1.5 text-sm rounded hover:bg-ink/5 truncate"
          >
            {c.name}
            <span className="text-ink/40 ml-2 text-xs">{c.entity_type}</span>
          </button>
        ))}
      </div>
      {trimmed.length > 0 && !exactMatch && (
        <button
          type="button"
          disabled={createClient.isPending}
          onClick={() => createClient.mutate()}
          className="mt-2 w-full text-left px-2 py-1.5 text-sm rounded border border-ink/15 hover:bg-ink/5 disabled:opacity-50"
        >
          {createClient.isPending ? 'Creating…' : `+ New client “${trimmed}”`}
        </button>
      )}
    </div>
  );
}
