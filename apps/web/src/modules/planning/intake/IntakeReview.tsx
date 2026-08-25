// TP-6a — the tie-out screen: one upload feeding two review surfaces.
// Numbers = the unchanged TP-7 anchor tie-out (PdfImport). Facts = the
// client-level candidate review (CandidateReview with planId, so accepting
// writes the client version AND the plan's `created` snapshot). Uploads go
// through POST /plans/:id/intake/document, which persists the client
// document and runs full ingest async — per-document status chips poll
// until extraction lands.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BaselineProfile, ClientDocumentDTO, PlanFactSnapshotDTO } from '@vibe/shared';
import { api, apiFetch } from '../../../lib/api';
import { CandidateReview } from '../../clients/facts/CandidateReview';
import { PdfImport, type IntakeResult } from './PdfImport';

export function IntakeReview({
  planId,
  clientId,
  profile,
  frozen,
}: {
  planId: string;
  clientId: string;
  profile: BaselineProfile;
  frozen: boolean;
}) {
  const [tab, setTab] = useState<'numbers' | 'facts'>('numbers');
  const [result, setResult] = useState<IntakeResult | null>(null);
  const [uploadedIds, setUploadedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: docsData } = useQuery<{ documents: ClientDocumentDTO[] }>({
    queryKey: ['client-documents', clientId, ''],
    queryFn: () => api(`/api/clients/${clientId}/documents`),
    refetchInterval: (q) =>
      (q.state.data?.documents ?? []).some(
        (d) => d.status === 'queued' || d.status === 'processing',
      )
        ? 4000
        : false,
  });

  const { data: snapshotsData } = useQuery<{ snapshots: PlanFactSnapshotDTO[] }>({
    queryKey: ['plan-fact-snapshots', planId],
    queryFn: () => api(`/api/planning/plans/${planId}/fact-snapshots`),
  });

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiFetch(`/api/planning/plans/${planId}/intake/document`, {
        method: 'POST',
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        document?: { id: string };
        existing_document_id?: string;
        intake?: IntakeResult | null;
      };
      if (!res.ok) {
        if (body.error === 'duplicate_document') {
          if (body.intake) setResult(body.intake);
          if (body.existing_document_id) {
            setUploadedIds((ids) =>
              ids.includes(body.existing_document_id!) ? ids : [...ids, body.existing_document_id!],
            );
          }
          setError('Already uploaded for this client — showing the stored parse.');
        } else if (body.error === 'ocr_not_configured') {
          setError('Scanned PDF — no OCR provider is configured. Enter the profile manually.');
        } else if (body.error === 'plan_frozen') {
          setError('This plan is frozen — intake is closed.');
        } else {
          setError(body.message ?? 'Upload failed — is this a readable PDF?');
        }
        return;
      }
      if (body.intake) setResult(body.intake);
      if (body.document) setUploadedIds((ids) => [...ids, body.document!.id]);
    } finally {
      setUploading(false);
    }
  }

  const uploadedDocs = (docsData?.documents ?? []).filter((d) => uploadedIds.includes(d.id));
  const snapshots = snapshotsData?.snapshots ?? [];
  const latest = snapshots[0] ?? null;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="border border-dashed border-ink/25 rounded p-6 text-center">
        <p className="text-sm text-ink/60 mb-3">
          Upload returns for this plan's client (1040, 1120-S, 1065, K-1…). Numbers parse locally
          and immediately; fact extraction runs on the redacted text in the background.
        </p>
        <label className="inline-block px-3 py-1.5 bg-ink text-paper rounded text-sm cursor-pointer">
          {uploading ? 'Uploading…' : 'Choose PDF…'}
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={uploading || frozen}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>
        {uploadedDocs.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {uploadedDocs.map((d) => (
              <span
                key={d.id}
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  d.status === 'indexed'
                    ? 'bg-moss/15 text-moss'
                    : d.status === 'failed'
                      ? 'bg-oxblood/10 text-oxblood'
                      : 'bg-gold/15 text-ink/60'
                }`}
                title={d.error_message ?? undefined}
              >
                {d.filename} · {d.status === 'indexed' ? d.doc_type : d.status}
              </span>
            ))}
          </div>
        )}
      </div>
      {error && <div className="text-oxblood text-sm">{error}</div>}

      <div className="flex gap-1 text-sm">
        {(
          [
            ['numbers', 'Numbers'],
            ['facts', 'Facts'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-1 rounded ${
              tab === key ? 'bg-ink text-paper' : 'text-ink/60 hover:bg-ink/5'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'numbers' && (
        <PdfImport
          planId={planId}
          profile={profile}
          frozen={frozen}
          result={result}
          onDiscard={() => setResult(null)}
        />
      )}
      {tab === 'facts' &&
        (frozen ? (
          <div className="text-ink/50 text-sm">This plan is frozen — fact review is closed.</div>
        ) : (
          <CandidateReview clientId={clientId} planId={planId} />
        ))}

      <div className="text-xs text-ink/40 border-t border-ink/10 pt-2">
        {latest
          ? `Plan snapshot: client facts v${latest.fact_pattern_version} (${latest.snapshot_kind}, ${new Date(latest.snapshot_at).toLocaleDateString()})`
          : 'No fact snapshot yet — accept extracted facts to create one.'}
      </div>
    </div>
  );
}
