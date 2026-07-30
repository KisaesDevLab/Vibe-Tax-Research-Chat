// TP-9 — plan deliverables: render each kind, watch status, download,
// mint/revoke signed links.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch, apiUrl, downloadErrorMessage } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';

interface DeliverableRow {
  id: string;
  kind: string;
  status: string;
  sha256: string | null;
  delivered_via: string | null;
  error: string | null;
  created_at: string;
}
interface LinkRow {
  id: string;
  expires_at: string;
  revoked_at: string | null;
  last_downloaded_at: string | null;
}

const KINDS = ['advisor-pdf', 'client-pdf', 'handout', 'pitch-deck', 'slideshow'] as const;

export function DeliverablesTab({ detail }: { detail: PlanDetail }) {
  const { plan } = detail;
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [linksFor, setLinksFor] = useState<string | null>(null);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);

  const { data } = useQuery<{ deliverables: DeliverableRow[] }>({
    queryKey: ['deliverables', plan.id],
    queryFn: () => api(`/api/planning/plans/${plan.id}/deliverables`),
    refetchInterval: (q) =>
      (q.state.data?.deliverables ?? []).some(
        (d) => d.status === 'queued' || d.status === 'rendering',
      )
        ? 3000
        : false,
  });

  const create = useMutation({
    mutationFn: (kind: string) =>
      api(`/api/planning/plans/${plan.id}/deliverables`, {
        method: 'POST',
        body: JSON.stringify({ kind }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['deliverables', plan.id] });
    },
    onError: (err) => setError(downloadErrorMessage(err)),
  });

  const mintLink = useMutation({
    mutationFn: (deliverableId: string) =>
      api<{ url: string; expires_at: string }>(
        `/api/planning/plans/${plan.id}/deliverables/${deliverableId}/links`,
        { method: 'POST', body: JSON.stringify({ ttl_days: 14 }) },
      ),
    onSuccess: (r) => {
      setMintedUrl(`${window.location.origin}${apiUrl(r.url)}`);
      qc.invalidateQueries({ queryKey: ['deliverable-links'] });
    },
    onError: (err) => setError(downloadErrorMessage(err)),
  });

  async function download(d: DeliverableRow) {
    try {
      const res = await apiFetch(`/api/planning/plans/${plan.id}/deliverables/${d.id}/download`);
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

  // Fetch the slideshow HTML with the Bearer token (auto-refresh on 401)
  // instead of a plain <a href>: the anchor rides a 15-minute cookie and
  // dumps raw 401 JSON in a new tab after idle. The window must open
  // synchronously — before any await — to keep the user-activation
  // gesture, or popup blockers kill it. The HTML is written straight into
  // the opened document; a blob: URL would die on F5 once revoked.
  function openSlideshow() {
    const win = window.open('', '_blank');
    if (!win) {
      setError('Popup blocked — allow popups to open the slideshow.');
      return;
    }
    void (async () => {
      try {
        const res = await apiFetch(`/api/planning/plans/${plan.id}/deliverables/slideshow-view`);
        const html = await res.text();
        win.document.open();
        win.document.write(html);
        win.document.close();
        setError(null);
      } catch (err) {
        win.close();
        setError(downloadErrorMessage(err));
      }
    })();
  }

  const rows = data?.deliverables ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => create.mutate(k)}
            disabled={create.isPending}
            className="px-2.5 py-1 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-50"
          >
            Render {k}
          </button>
        ))}
        <button
          onClick={() => openSlideshow()}
          className="px-2.5 py-1 text-sm underline text-ink/60"
        >
          Slideshow web view →
        </button>
      </div>
      {error && <div className="text-oxblood text-sm">{error}</div>}
      {mintedUrl && (
        <div className="text-sm bg-moss/10 border border-moss/30 rounded p-2 break-all">
          Signed link (14 days): <span className="font-mono text-xs">{mintedUrl}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-6 text-center">
          Nothing rendered yet. Client-facing kinds unlock at “presented”.
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-3">Kind</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">SHA-256</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-ink/5 align-top">
                <td className="py-2 pr-3">{d.kind}</td>
                <td className="py-2 pr-3">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      d.status === 'ready'
                        ? 'bg-moss/15 text-moss'
                        : d.status === 'failed'
                          ? 'bg-oxblood/10 text-oxblood'
                          : 'bg-gold/15 text-ink/60'
                    }`}
                    title={d.error ?? undefined}
                  >
                    {d.status}
                  </span>
                  {/* A failure reason hidden in a tooltip is a failure reason
                      nobody reads — show it where the operator is looking. */}
                  {d.status === 'failed' && d.error && (
                    <div className="mt-1 text-[11px] text-oxblood/90 max-w-md whitespace-pre-wrap break-words">
                      {d.error}
                      {/rela(t|)ion .* does not exist|column .* does not exist/i.test(d.error) && (
                        <div className="text-ink/50 mt-0.5">
                          The database schema is behind this build — run migrations (
                          <code>pnpm db:migrate</code>, or set <code>MIGRATIONS_AUTO=true</code>)
                          and render again.
                        </div>
                      )}
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 font-mono text-[10px] text-ink/40">
                  {d.sha256 ? `${d.sha256.slice(0, 16)}…` : '—'}
                </td>
                <td className="py-2 text-right space-x-3">
                  {d.status === 'ready' && (
                    <>
                      <button onClick={() => void download(d)} className="underline text-xs">
                        Download
                      </button>
                      <button onClick={() => mintLink.mutate(d.id)} className="underline text-xs">
                        Signed link
                      </button>
                      <button
                        onClick={() => setLinksFor(linksFor === d.id ? null : d.id)}
                        className="underline text-xs text-ink/50"
                      >
                        Links
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {linksFor && <LinkList planId={plan.id} deliverableId={linksFor} />}
    </div>
  );
}

function LinkList({ planId, deliverableId }: { planId: string; deliverableId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ links: LinkRow[] }>({
    queryKey: ['deliverable-links', deliverableId],
    queryFn: () => api(`/api/planning/plans/${planId}/deliverables/${deliverableId}/links`),
  });
  const revoke = useMutation({
    mutationFn: (linkId: string) =>
      api(`/api/planning/plans/${planId}/deliverables/${deliverableId}/links/${linkId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deliverable-links', deliverableId] }),
  });
  const rows = data?.links ?? [];
  if (rows.length === 0) return <div className="text-xs text-ink/40">No links minted.</div>;
  return (
    <ul className="text-xs space-y-1 border border-ink/10 rounded p-3">
      {rows.map((l) => (
        <li key={l.id} className="flex items-center gap-3">
          <span>expires {new Date(l.expires_at).toLocaleDateString()}</span>
          {l.last_downloaded_at && (
            <span className="text-ink/40">
              last download {new Date(l.last_downloaded_at).toLocaleString()}
            </span>
          )}
          {l.revoked_at ? (
            <span className="text-oxblood">revoked</span>
          ) : (
            <button onClick={() => revoke.mutate(l.id)} className="underline text-oxblood">
              revoke
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
