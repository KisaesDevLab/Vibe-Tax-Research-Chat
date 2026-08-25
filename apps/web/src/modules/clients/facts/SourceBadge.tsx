// TP-3a — provenance badge. Extracted facts show the source page (moss,
// click-through opens the stored PDF at that page — Chromium's viewer honors
// #page=N; elsewhere it degrades to page 1). Staff-entered facts (no
// sources) get a gold outline badge per the addendum.
import type { FactSource } from '@vibe/shared';
import { apiFetch } from '../../../lib/api';

export async function openDocumentAtPage(clientId: string, documentId: string, page: number) {
  const res = await apiFetch(`/api/clients/${clientId}/documents/${documentId}/file`);
  if (!res.ok) {
    window.alert(
      res.status === 404 || res.status === 410
        ? 'Source document removed.'
        : 'Could not open document.',
    );
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(`${url}#page=${page}`, '_blank', 'noopener');
}

const METHOD_STYLE: Record<string, string> = {
  extracted: 'bg-moss/15 text-moss',
  tb_sync: 'bg-ink/10 text-ink/60',
  chat_confirmed: 'bg-gold/15 text-ink/70',
};

export function SourceBadge({
  clientId,
  sources,
}: {
  clientId: string;
  sources: FactSource[] | null | undefined;
}) {
  if (!sources || sources.length === 0) {
    return (
      <span
        title="Staff-entered — no document source"
        className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-gold/60 text-gold"
      >
        staff
      </span>
    );
  }
  return (
    <span className="inline-flex gap-1">
      {sources.slice(0, 3).map((s, i) => (
        <button
          key={`${s.documentId}-${s.page}-${i}`}
          onClick={() => void openDocumentAtPage(clientId, s.documentId, s.page)}
          title={`${s.method} — open source at page ${s.page}`}
          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
            METHOD_STYLE[s.method] ?? 'bg-ink/10 text-ink/60'
          } hover:opacity-80`}
        >
          p.{s.page}
        </button>
      ))}
      {sources.length > 3 && <span className="text-[10px] text-ink/40">+{sources.length - 3}</span>}
    </span>
  );
}
