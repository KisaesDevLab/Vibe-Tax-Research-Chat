// Phase 32 — Reference Library admin page.
//
// Three sections on one screen:
//   1. Upload form — file + title + tags. Submitting POSTs multipart to
//      /api/admin/references and the row appears in the table at status
//      = 'queued'. Background worker advances it to 'indexed' or 'failed'.
//   2. Library table — every uploaded reference with status badge, chunk
//      count (after ingest), tags, and per-row actions (re-ingest /
//      delete). Polls every 5 s while any row is in queued/processing
//      so the admin sees live progress.
//   3. Test retrieval — type a query, hit "Search", see the top-k
//      reference_chunks with their similarity scores. Lets the admin
//      verify the pipeline end-to-end without burning an Anthropic
//      chat turn.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiFetch, ApiError } from '../../lib/api';

interface ReferenceRow {
  id: string;
  title: string;
  source: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  tags: string[];
  status: 'queued' | 'processing' | 'indexed' | 'failed';
  error_message: string | null;
  token_count: number | null;
  sha256: string | null;
  created_at: string;
  processed_at: string | null;
}

interface RetrievedExcerpt {
  document_id: string;
  document_title: string;
  document_tags: string[];
  chunk_id: string;
  chunk_index: number;
  similarity: number;
  text: string;
  page_number: number | null;
}

const STATUS_CLASSES: Record<ReferenceRow['status'], string> = {
  queued: 'bg-amber-100 text-amber-900',
  processing: 'bg-sky-100 text-sky-900',
  indexed: 'bg-emerald-100 text-emerald-900',
  failed: 'bg-rose-100 text-rose-900',
};

function formatBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function humanError(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; detail?: unknown } | null;
    if (body?.error) return body.error;
    return `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export function AdminReferencesPage() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ references: ReferenceRow[] }>({
    queryKey: ['admin', 'references'],
    queryFn: () => api('/api/admin/references?limit=200'),
    // Poll while any row is mid-ingest so the admin sees the status
    // transition without a manual refresh.
    refetchInterval: (q) => {
      const rows = q.state.data?.references ?? [];
      const inflight = rows.some((r) => r.status === 'queued' || r.status === 'processing');
      return inflight ? 5000 : false;
    },
  });

  const references = data?.references ?? [];

  const upload = useMutation({
    mutationFn: async (form: FormData) => {
      const res = await apiFetch('/api/admin/references', {
        method: 'POST',
        body: form,
      });
      return (await res.json()) as { id: string; status: string };
    },
    onSuccess: () => {
      setTitle('');
      setTagsInput('');
      if (fileRef.current) fileRef.current.value = '';
      setUploadError(null);
      qc.invalidateQueries({ queryKey: ['admin', 'references'] });
    },
    onError: (e) => setUploadError(humanError(e)),
  });

  const reingest = useMutation({
    mutationFn: (id: string) => api(`/api/admin/references/${id}/reingest`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'references'] }),
    onError: (e) => setActionError(humanError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/references/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'references'] }),
    onError: (e) => setActionError(humanError(e)),
  });

  function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError('Choose a file first.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    if (title.trim()) form.append('title', title.trim());
    if (tagsInput.trim()) form.append('tags', tagsInput.trim());
    upload.mutate(form);
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <header>
        <h1 className="font-display text-2xl">Firm reference library</h1>
        <p className="text-sm text-ink/60">
          Upload firm-internal research memos, treatises, and reference PDFs. Indexed documents are
          retrieved at chat time and injected into the system prompt under{' '}
          <code>&lt;reference_excerpts&gt;</code>. Citations appear as
          <em> [Firm Reference: title, p.N]</em> — separate from primary authority.
        </p>
      </header>

      <section className="border border-ink/10 rounded-lg p-5">
        <h2 className="font-display text-lg mb-3">Upload</h2>
        <form onSubmit={onUpload} className="space-y-3">
          <div>
            <label className="block text-xs uppercase tracking-wider text-ink/60 mb-1">File</label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.html,.htm,.csv,.tsv,.xlsx,.xls"
              className="block text-sm"
            />
            <p className="text-xs text-ink/50 mt-1">
              PDF, DOCX, TXT, MD, HTML, CSV, XLSX. Up to 100 MB. Scanned PDFs need OCR upstream —
              they'll fail ingest with "parsed text is empty".
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink/60 mb-1">
                Title (optional)
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to the filename"
                className="w-full border border-ink/20 rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink/60 mb-1">
                Tags (comma-separated, optional)
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="e.g. partnership, 754-elections"
                className="w-full border border-ink/20 rounded px-2 py-1 text-sm"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={upload.isPending}
              className="px-4 py-1.5 rounded bg-ink text-paper text-sm disabled:opacity-50"
            >
              {upload.isPending ? 'Uploading…' : 'Upload + ingest'}
            </button>
            {uploadError && <span className="text-sm text-rose-700">{uploadError}</span>}
          </div>
        </form>
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-display text-lg">Library ({references.length})</h2>
          {actionError && <span className="text-sm text-rose-700">{actionError}</span>}
        </div>
        {isLoading ? (
          <div className="text-sm text-ink/60">Loading…</div>
        ) : references.length === 0 ? (
          <div className="text-sm text-ink/60">
            No references yet. Upload one above to get started.
          </div>
        ) : (
          <div className="border border-ink/10 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-ink/5 text-left text-xs uppercase tracking-wider text-ink/70">
                <tr>
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Tags</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Tokens</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {references.map((r) => (
                  <tr key={r.id} className="border-t border-ink/10">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.title}</div>
                      {r.original_filename && r.original_filename !== r.title && (
                        <div className="text-xs text-ink/50">{r.original_filename}</div>
                      )}
                      {r.error_message && (
                        <div className="text-xs text-rose-700 mt-1">{r.error_message}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_CLASSES[r.status]}`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.tags.map((t) => (
                          <span key={t} className="text-xs bg-ink/10 rounded px-1.5 py-0.5">
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-ink/70">{formatBytes(r.size_bytes)}</td>
                    <td className="px-3 py-2 text-ink/70">
                      {r.token_count ? r.token_count.toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-2">
                        {r.status === 'failed' && (
                          <button
                            onClick={() => reingest.mutate(r.id)}
                            className="text-xs underline"
                            disabled={reingest.isPending}
                          >
                            Re-ingest
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (confirm(`Delete "${r.title}"?`)) remove.mutate(r.id);
                          }}
                          className="text-xs text-rose-700 underline"
                          disabled={remove.isPending}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <TestRetrievalSection references={references} />
    </div>
  );
}

function TestRetrievalSection({ references }: { references: ReferenceRow[] }) {
  const [query, setQuery] = useState('');
  const [excerpts, setExcerpts] = useState<RetrievedExcerpt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const indexedCount = useMemo(
    () => references.filter((r) => r.status === 'indexed').length,
    [references],
  );

  const test = useMutation({
    mutationFn: () =>
      api<{ excerpts: RetrievedExcerpt[] }>('/api/admin/references/test-retrieval', {
        method: 'POST',
        body: JSON.stringify({ query, k: 8 }),
      }),
    onSuccess: (r) => {
      setExcerpts(r.excerpts);
      setError(null);
    },
    onError: (e) => {
      setError(humanError(e));
      setExcerpts([]);
    },
  });

  return (
    <section>
      <h2 className="font-display text-lg mb-3">Test retrieval</h2>
      <p className="text-sm text-ink/60 mb-3">
        Embed a query and see what would be injected into the system prompt at chat time. Useful for
        debugging chunking, embedding, and tag coverage.
        {indexedCount === 0 && ' No indexed references yet — upload some above first.'}
      </p>
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What's the threshold for a §754 step-up to be required?"
          className="flex-1 border border-ink/20 rounded px-2 py-1 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim()) test.mutate();
          }}
        />
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending || !query.trim()}
          className="px-4 py-1.5 rounded bg-ink text-paper text-sm disabled:opacity-50"
        >
          {test.isPending ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <div className="text-sm text-rose-700 mb-3">{error}</div>}
      {excerpts && excerpts.length === 0 && <div className="text-sm text-ink/60">No matches.</div>}
      {excerpts && excerpts.length > 0 && (
        <div className="space-y-3">
          {excerpts.map((e) => (
            <div key={e.chunk_id} className="border border-ink/10 rounded-lg p-3 text-sm">
              <div className="flex items-baseline justify-between text-xs text-ink/60 mb-1">
                <span>
                  <strong className="text-ink">{e.document_title}</strong>
                  {e.page_number != null && ` · p.${e.page_number}`}
                </span>
                <span>similarity: {e.similarity.toFixed(3)}</span>
              </div>
              <div className="whitespace-pre-wrap text-ink">{e.text}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
