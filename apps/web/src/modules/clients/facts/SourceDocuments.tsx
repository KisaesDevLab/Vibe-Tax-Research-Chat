// TP-3a — the source-documents section of the Documents tab: upload →
// intake trigger, docType filter, ingest-status polling, view/re-ingest/
// delete. Deliverables render below it (unchanged).
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientDocumentDTO } from '@vibe/shared';
import { api, apiFetch } from '../../../lib/api';
import { openDocumentAtPage } from './SourceBadge';

const DOC_TYPES = [
  'f1040',
  'f1120s',
  'f1120',
  'f1065',
  'k1',
  'f990',
  'state_return',
  'engagement_letter',
  'correspondence',
  'other',
] as const;

const STATUS_STYLE: Record<string, string> = {
  indexed: 'bg-moss/15 text-moss',
  failed: 'bg-oxblood/10 text-oxblood',
  queued: 'bg-gold/15 text-ink/60',
  processing: 'bg-gold/15 text-ink/60',
};

export function SourceDocuments({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ documents: ClientDocumentDTO[] }>({
    queryKey: ['client-documents', clientId, filter],
    queryFn: () => api(`/api/clients/${clientId}/documents${filter ? `?doc_type=${filter}` : ''}`),
    refetchInterval: (q) =>
      (q.state.data?.documents ?? []).some(
        (d) => d.status === 'queued' || d.status === 'processing',
      )
        ? 4000
        : false,
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch(`/api/clients/${clientId}/documents`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `upload_failed_${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['client-documents', clientId] });
    },
    onError: (err) => {
      const code = err instanceof Error ? err.message : '';
      setError(
        code === 'duplicate_document'
          ? 'This file is already uploaded for this client.'
          : code === 'pdf_required'
            ? 'Only PDF files are supported.'
            : 'Upload failed — try again.',
      );
    },
  });

  const reingest = useMutation({
    mutationFn: (docId: string) =>
      api(`/api/clients/${clientId}/documents/${docId}/reingest`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['client-documents', clientId] }),
  });

  const remove = useMutation({
    mutationFn: (docId: string) =>
      api(`/api/clients/${clientId}/documents/${docId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-documents', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-fact-candidates', clientId] });
    },
  });

  const rows = data?.documents ?? [];

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-lg">Source documents</h3>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="border border-ink/20 rounded px-2 py-1 text-sm bg-white"
          >
            <option value="">All types</option>
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploadMutation.isPending}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {uploadMutation.isPending ? 'Uploading…' : 'Upload PDF'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadMutation.mutate(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {error && <div className="text-oxblood text-sm mb-2">{error}</div>}
      {isLoading ? (
        <div className="text-ink/50 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-6 text-center text-sm">
          No source documents yet. Upload a return to extract facts and enable document-grounded
          research.
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-3">File</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Year</th>
              <th className="py-2 pr-3">Pages</th>
              <th className="py-2 pr-3">Status</th>
              <th className="py-2 pr-3">Facts</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-ink/5 align-top">
                <td className="py-2 pr-3">
                  <button
                    onClick={() => void openDocumentAtPage(clientId, d.id, 1)}
                    className="underline underline-offset-2 hover:text-moss text-left"
                  >
                    {d.filename}
                  </button>
                </td>
                <td className="py-2 pr-3 text-ink/60">{d.doc_type}</td>
                <td className="py-2 pr-3 text-ink/60">{d.tax_year ?? '—'}</td>
                <td className="py-2 pr-3 text-ink/60">{d.page_count ?? '—'}</td>
                <td className="py-2 pr-3">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      STATUS_STYLE[d.status] ?? 'bg-ink/10 text-ink/60'
                    }`}
                    title={d.error_message ?? d.extraction_error ?? undefined}
                  >
                    {d.status}
                  </span>
                  {d.status === 'failed' && d.error_message && (
                    <div className="text-xs text-oxblood mt-1 max-w-56">
                      {d.error_message.startsWith('This PDF has no text layer')
                        ? 'Scanned PDF — no OCR provider configured.'
                        : d.error_message}
                    </div>
                  )}
                  {d.extraction_error && d.status === 'indexed' && (
                    <div className="text-xs text-gold mt-1 max-w-56">
                      Indexed, but fact extraction failed.
                    </div>
                  )}
                </td>
                <td className="py-2 pr-3 text-ink/60">
                  {d.pending_candidate_count > 0 ? `${d.pending_candidate_count} pending` : '—'}
                </td>
                <td className="py-2 text-right space-x-2 whitespace-nowrap">
                  {d.status === 'failed' && (
                    <button
                      onClick={() => reingest.mutate(d.id)}
                      className="underline text-xs"
                      disabled={reingest.isPending}
                    >
                      Re-ingest
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (window.confirm(`Delete “${d.filename}”? Extracted chunks go with it.`)) {
                        remove.mutate(d.id);
                      }
                    }}
                    className="underline text-xs text-oxblood"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
