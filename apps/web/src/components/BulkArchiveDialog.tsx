// TP-11 — bulk archive: selected chats freeze with their existing titles
// (no Claude call). Chats where the PII detector finds hits are NOT
// silently archived — they're reported back for individual handling
// through the single-session dialog.
import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../lib/api';
import { useActiveClient } from '../lib/active-client';

interface BulkResult {
  archived: string[];
  pii_review_required: string[];
  not_found: string[];
}

export function BulkArchiveDialog({
  chatIds,
  onClose,
  onDone,
}: {
  chatIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { activeClient } = useActiveClient();
  const [firmArchive, setFirmArchive] = useState(false);
  const [clientId, setClientId] = useState<string | null>(activeClient?.id ?? null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: debounced }],
    queryFn: () => api(`/api/clients?q=${encodeURIComponent(debounced)}`),
    enabled: !firmArchive,
  });

  const run = useMutation({
    mutationFn: () =>
      api<BulkResult>('/api/archives/bulk', {
        method: 'POST',
        body: JSON.stringify({
          chat_ids: chatIds,
          client_id: firmArchive ? null : clientId,
          firm_archive: firmArchive,
        }),
      }),
    onSuccess: (r) => setResult(r),
    onError: (err) => setError((err as Error).message),
  });

  const rows = data?.clients ?? [];
  const selectedClient = rows.find((c) => c.id === clientId);

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) (result ? onDone : onClose)();
      }}
    >
      <div className="bg-white rounded shadow-xl p-6 w-full max-w-md">
        {result ? (
          <>
            <h2 className="font-display text-xl mb-3">Bulk archive complete</h2>
            <ul className="text-sm space-y-1 mb-4">
              <li>{result.archived.length} archived.</li>
              {result.pii_review_required.length > 0 && (
                <li className="text-oxblood">
                  {result.pii_review_required.length} skipped — possible identifiers detected. Open
                  each session and archive it individually to review redactions.
                </li>
              )}
              {result.not_found.length > 0 && (
                <li className="text-ink/50">{result.not_found.length} not found.</li>
              )}
            </ul>
            <div className="flex justify-end">
              <button onClick={onDone} className="px-3 py-1.5 bg-ink text-paper rounded text-sm">
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="font-display text-xl mb-1">Archive {chatIds.length} sessions</h2>
            <p className="text-sm text-ink/60 mb-4">
              Each session freezes with its current title. Sessions with detected identifiers are
              skipped for individual review.
            </p>
            <label className="flex items-center gap-2 text-sm mb-2">
              <input
                type="checkbox"
                checked={firmArchive}
                onChange={(e) => setFirmArchive(e.target.checked)}
              />
              <span>Firm-level archive (no client)</span>
            </label>
            {!firmArchive && (
              <div className="mb-3">
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={selectedClient?.name ?? activeClient?.name ?? 'Search clients…'}
                  className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
                />
                {debounced && (
                  <div className="border border-ink/10 rounded mt-1 max-h-36 overflow-y-auto">
                    {rows.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setClientId(c.id);
                          setQ('');
                        }}
                        className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-ink/5 ${
                          clientId === c.id ? 'bg-ink/10' : ''
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 border border-ink/20 rounded text-sm"
              >
                Cancel
              </button>
              <button
                disabled={(!firmArchive && !clientId) || run.isPending}
                onClick={() => run.mutate()}
                className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
              >
                {run.isPending ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
