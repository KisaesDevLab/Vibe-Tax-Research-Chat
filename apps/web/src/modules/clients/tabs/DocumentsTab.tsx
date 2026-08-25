// TP-9 — documents tab: every deliverable across the client's plans,
// with sha256, render status, and delivery method. TP-3a prepends the
// source-documents section (upload → intake trigger, docType filter).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api, apiFetch, downloadErrorMessage } from '../../../lib/api';
import { SourceDocuments } from '../facts/SourceDocuments';

interface DeliverableRow {
  id: string;
  plan_id: string;
  plan_title: string;
  kind: string;
  status: string;
  sha256: string | null;
  delivered_via: string | null;
  rendered_at: string | null;
  created_at: string;
}

export function DocumentsTab({ client }: { client: ClientDTO }) {
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ deliverables: DeliverableRow[] }>({
    queryKey: ['client-deliverables', client.id],
    queryFn: () => api(`/api/clients/${client.id}/deliverables`),
    refetchInterval: (q) =>
      (q.state.data?.deliverables ?? []).some(
        (d) => d.status === 'queued' || d.status === 'rendering',
      )
        ? 4000
        : false,
  });

  async function download(d: DeliverableRow) {
    try {
      const res = await apiFetch(`/api/planning/plans/${d.plan_id}/deliverables/${d.id}/download`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.kind}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (err) {
      setError(downloadErrorMessage(err));
    }
  }

  const rows = data?.deliverables ?? [];
  return (
    <div>
      <SourceDocuments clientId={client.id} />
      <h3 className="font-display text-lg mb-3">Deliverables</h3>
      {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          No deliverables yet — render them from a plan once it's computed.
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-3">Kind</th>
              <th className="py-2 pr-3">Plan</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Delivery</th>
              <th className="py-2 pr-3">SHA-256</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-ink/5">
                <td className="py-2 pr-3">{d.kind}</td>
                <td className="py-2 pr-3 text-ink/60">{d.plan_title}</td>
                <td className="py-2 pr-3">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      d.status === 'ready'
                        ? 'bg-moss/15 text-moss'
                        : d.status === 'failed'
                          ? 'bg-oxblood/10 text-oxblood'
                          : 'bg-gold/15 text-ink/60'
                    }`}
                  >
                    {d.status}
                  </span>
                </td>
                <td className="py-2 pr-3 text-ink/60">{d.delivered_via ?? '—'}</td>
                <td className="py-2 pr-3 font-mono text-[10px] text-ink/40">
                  {d.sha256 ? `${d.sha256.slice(0, 16)}…` : '—'}
                </td>
                <td className="py-2 text-right">
                  {d.status === 'ready' && (
                    <button onClick={() => void download(d)} className="underline text-xs">
                      Download
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
