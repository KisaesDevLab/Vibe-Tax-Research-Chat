// TP-12 — review-queue admin UI: the human gate for every pipeline-
// drafted change. Strategy drafts render side-by-side (draft vs
// published) with the validator verdict; approve publishes, reject
// deprecates the draft. Polls while items are open so job-produced
// items appear without a refresh.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface QueueItem {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'open' | 'approved' | 'rejected';
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

interface DetailResponse {
  item: QueueItem;
  draft: { id: string; semver: string; status: string; content: Record<string, unknown> } | null;
  published: { id: string; semver: string; content: Record<string, unknown> } | null;
}

interface ValidationPayload {
  ok: boolean;
  errors: Array<{ gate: string; path: string; message: string }>;
}

export function AdminReviewQueuePage() {
  const [status, setStatus] = useState<'open' | 'approved' | 'rejected'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{
    items: QueueItem[];
    counts: { open: number; approved: number; rejected: number };
  }>({
    queryKey: ['admin', 'review-queue', status],
    queryFn: () => api(`/api/admin/review-queue?status=${status}`),
    refetchInterval: status === 'open' ? 15_000 : false,
  });

  const items = data?.items ?? [];

  return (
    <div>
      <h1 className="font-display text-3xl mb-2">Review queue</h1>
      <p className="text-sm text-ink/60 mb-4 max-w-2xl">
        Every pipeline-drafted change lands here. Nothing publishes without a decision on this
        screen.
      </p>
      <div className="flex gap-2 mb-4">
        {(['open', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setSelectedId(null);
            }}
            className={`px-3 py-1 rounded text-sm border ${
              status === s ? 'bg-ink text-paper border-ink' : 'border-ink/20 hover:bg-ink/5'
            }`}
          >
            {s}
            {data?.counts && <span className="ml-1 text-[10px] opacity-70">{data.counts[s]}</span>}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          Nothing {status} — the pipeline queues drafts here when jobs run.
        </div>
      ) : (
        <table className="w-full max-w-3xl text-sm border-collapse mb-6">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Kind</th>
              <th className="py-2 pr-4">Subject</th>
              <th className="py-2 pr-4">Validation</th>
              <th className="py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const validation = item.payload.validation as ValidationPayload | undefined;
              return (
                <tr
                  key={item.id}
                  onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                  className={`border-b border-ink/5 cursor-pointer hover:bg-ink/5 ${
                    selectedId === item.id ? 'bg-ink/10' : ''
                  }`}
                >
                  <td className="py-2 pr-4">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10">
                      {item.kind}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {String(item.payload.strategy_id ?? item.payload.subject ?? '—')}
                    {typeof item.payload.semver === 'string' && ` @ ${item.payload.semver}`}
                  </td>
                  <td className="py-2 pr-4">
                    {validation ? (
                      validation.ok ? (
                        <span className="text-moss text-xs">passes gates</span>
                      ) : (
                        <span className="text-oxblood text-xs">
                          {validation.errors.length} gate failure(s)
                        </span>
                      )
                    ) : (
                      <span className="text-ink/40 text-xs">—</span>
                    )}
                  </td>
                  <td className="py-2 text-ink/60">{new Date(item.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {selectedId && <QueueItemDetail id={selectedId} onDecided={() => setSelectedId(null)} />}
    </div>
  );
}

function QueueItemDetail({ id, onDecided }: { id: string; onDecided: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery<DetailResponse>({
    queryKey: ['admin', 'review-queue-item', id],
    queryFn: () => api(`/api/admin/review-queue/${id}`),
  });

  const decide = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      api(`/api/admin/review-queue/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'review-queue'] });
      onDecided();
    },
    onError: (err) => setError((err as Error).message),
  });

  if (isLoading) return <div className="text-ink/50">Loading item…</div>;
  if (!data) return null;
  const { item, draft, published } = data;
  const validation = item.payload.validation as ValidationPayload | undefined;

  return (
    <div className="space-y-4 max-w-6xl">
      {item.status === 'open' && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => decide.mutate('approve')}
            disabled={decide.isPending}
            className="px-4 py-1.5 rounded bg-moss text-paper text-sm disabled:opacity-50"
          >
            Approve{item.kind === 'strategy-draft' ? ' & publish' : ''}
          </button>
          <button
            onClick={() => decide.mutate('reject')}
            disabled={decide.isPending}
            className="px-4 py-1.5 rounded border border-oxblood text-oxblood text-sm disabled:opacity-50"
          >
            Reject
          </button>
          {validation && !validation.ok && (
            <span className="text-xs text-oxblood">
              Draft has unresolved validator failures — publishing anyway is possible but
              discouraged.
            </span>
          )}
          {error && <span className="text-xs text-oxblood">{error}</span>}
        </div>
      )}
      {validation && validation.errors.length > 0 && (
        <section className="border border-gold/40 bg-gold/10 rounded p-3 text-xs">
          <div className="font-medium mb-1">Validator output</div>
          <ul className="space-y-0.5">
            {validation.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono">[{e.gate}]</span> {e.path}: {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="border border-ink/10 rounded p-3 bg-white min-w-0">
          <h3 className="font-display text-lg mb-1">
            Draft {draft ? `(${draft.semver}, ${draft.status})` : ''}
          </h3>
          <pre className="text-[11px] font-mono overflow-auto max-h-[32rem] bg-ink/5 rounded p-2">
            {JSON.stringify(draft?.content ?? item.payload, null, 2)}
          </pre>
        </section>
        <section className="border border-ink/10 rounded p-3 bg-white min-w-0">
          <h3 className="font-display text-lg mb-1">
            Published {published ? `(${published.semver})` : ''}
          </h3>
          <pre className="text-[11px] font-mono overflow-auto max-h-[32rem] bg-ink/5 rounded p-2">
            {published ? JSON.stringify(published.content, null, 2) : '— none —'}
          </pre>
        </section>
      </div>
    </div>
  );
}
