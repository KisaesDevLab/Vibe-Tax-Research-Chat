// TP-11 — read-only archive viewer: frozen transcript with citation links
// intact, sha256 provenance line, superseded/tombstone badges, PDF export.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ArchiveDetailDTO } from '@vibe/shared';
import { api, apiFetch, downloadErrorMessage } from '../../lib/api';
import { stripSidecars } from '../../lib/sidecars';
import { Markdown } from '../../components/Markdown';

export function ArchiveViewer() {
  const { clientId, archiveId } = useParams<{ clientId: string; archiveId: string }>();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ archive: ArchiveDetailDTO }>({
    queryKey: ['archive', archiveId],
    queryFn: () => api(`/api/archives/${archiveId}`),
    enabled: Boolean(archiveId),
  });

  if (isLoading) return <div className="p-8 text-ink/50">Loading…</div>;
  const archive = data?.archive;
  if (!archive) return <div className="p-8 text-ink/50">Archive not found.</div>;

  async function downloadPdf() {
    try {
      const res = await apiFetch(`/api/archives/${archive!.id}/pdf`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `archive-${archive!.title.slice(0, 40)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setDownloadError(null);
    } catch (err) {
      setDownloadError(downloadErrorMessage(err));
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 max-w-4xl">
      <div className="text-xs text-ink/40 mb-1">
        <Link to="/clients" className="hover:underline">
          Clients
        </Link>{' '}
        /{' '}
        <Link to={`/clients/${clientId}/research`} className="hover:underline">
          Research
        </Link>{' '}
        / {archive.title}
      </div>
      <div className="flex items-start justify-between gap-4 mb-2">
        <h1 className="font-display text-2xl">{archive.title}</h1>
        <button
          onClick={() => void downloadPdf()}
          className="shrink-0 px-3 py-1.5 border border-ink/20 rounded text-sm"
        >
          Export PDF
        </button>
      </div>
      {downloadError && <div className="text-oxblood text-sm mb-2">{downloadError}</div>}
      <div className="text-xs text-ink/50 mb-1 flex flex-wrap gap-x-3">
        <span>Archived {new Date(archive.archived_at).toLocaleString()}</span>
        {archive.topic_tags.length > 0 && <span>{archive.topic_tags.join(' · ')}</span>}
        {archive.status === 'superseded' && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-ink/10 rounded">
            superseded
          </span>
        )}
      </div>
      {archive.tombstone && (
        <div className="text-xs text-oxblood/80 mb-1">
          Originally filed to {archive.tombstone.original_client.name}; reassigned to the firm
          archive when that client was deleted (
          {new Date(archive.tombstone.at).toLocaleDateString()}).
        </div>
      )}
      {archive.note && <div className="text-sm text-ink/70 mb-1">Note: {archive.note}</div>}
      <div className="font-mono text-[10px] text-ink/30 mb-6 break-all">
        SHA-256 {archive.sha256}
      </div>

      <div className="space-y-6">
        {archive.snapshot.messages.map((m, i) => (
          <div key={i} className="border-l-2 border-ink/10 pl-4">
            <div className="text-[10px] uppercase tracking-wider text-ink/40 mb-1">
              {m.role} · {new Date(m.created_at).toLocaleString()}
            </div>
            <div className="text-sm">
              {/* Same stripping the live chat does — the frozen snapshot holds
                  the raw turn, sidecar JSON and all. */}
              <Markdown>{stripSidecars(m.content)}</Markdown>
            </div>
          </div>
        ))}
      </div>

      {archive.snapshot.consultations.length > 0 && (
        <div className="mt-8 border-t border-ink/10 pt-4">
          <h2 className="font-display text-lg mb-2">Primary-source consultations</h2>
          <ul className="text-xs text-ink/60 space-y-1">
            {archive.snapshot.consultations.map((c, i) => (
              <li key={i} className="truncate">
                {c.tool_name}
                {' · '}
                {c.url ? (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-oxblood"
                  >
                    {c.url}
                  </a>
                ) : (
                  (c.query ?? '')
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
