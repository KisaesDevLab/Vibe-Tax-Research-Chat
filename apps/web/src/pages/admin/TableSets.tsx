// TP-4 — table-set viewer. TP-14 write paths: the tables:draft → review →
// publish flow, plus (a) a manual "Draft next year" trigger for when the
// annual cron ran before the official figures published, and (b) inline
// editing of DRAFT payloads/source notes before review. Published sets
// stay immutable — plans pin them.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TableSetDTO, TableSetSourceNote } from '@vibe/shared';
import { api, ApiError } from '../../lib/api';

interface TableSetListRow {
  id: string;
  tax_year: number;
  version: number;
  status: 'draft' | 'published';
  published_at: string | null;
  created_at: string;
}

export function AdminTableSetsPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ table_sets: TableSetListRow[] }>({
    queryKey: ['admin', 'table-sets'],
    queryFn: () => api('/api/admin/table-sets'),
  });

  const draftNow = useMutation({
    mutationFn: () => api<{ job_id: string }>('/api/admin/table-sets/draft', { method: 'POST' }),
    onSuccess: () =>
      setNotice(
        'Drafting started. Claude verifies figures against official sources (web search over the ' +
          'trusted-source allowlist); the draft lands in the Review queue in a few minutes. ' +
          'If an open table-draft review item already exists, no new draft is created.',
      ),
    onError: (e) => setNotice(`Draft failed to start: ${(e as Error).message}`),
  });

  const rows = data?.table_sets ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-display text-3xl">Table sets</h1>
        <button
          onClick={() => draftNow.mutate()}
          disabled={draftNow.isPending}
          className="px-3 py-1.5 border border-ink/20 rounded text-sm disabled:opacity-50"
          title="Runs the tables-draft job now — for when the annual cron ran before the official figures published"
        >
          {draftNow.isPending ? 'Starting…' : 'Draft next year now'}
        </button>
      </div>
      <p className="text-sm text-ink/60 mb-4 max-w-2xl">
        Versioned tax constants the planning engine computes from. Plans pin a table set at compute
        time; publishing a new set never changes an issued plan. Drafts run automatically on Oct 1
        and Nov 15 (skipped while a draft is already awaiting review).
      </p>
      {notice && (
        <div className="border border-gold/40 bg-gold/5 text-ink/80 text-sm rounded p-3 mb-4 flex items-baseline justify-between gap-3 max-w-2xl">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="underline whitespace-nowrap">
            Dismiss
          </button>
        </div>
      )}
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          No table sets. Enable the planning module and re-run the seed.
        </div>
      ) : (
        <table className="w-full max-w-2xl text-sm border-collapse mb-6">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Tax year</th>
              <th className="py-2 pr-4">Version</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2">Published</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                className={`border-b border-ink/5 cursor-pointer hover:bg-ink/5 ${
                  selectedId === r.id ? 'bg-ink/10' : ''
                }`}
              >
                <td className="py-2 pr-4 font-mono">{r.tax_year}</td>
                <td className="py-2 pr-4 font-mono">v{r.version}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      r.status === 'published' ? 'bg-moss/15 text-moss' : 'bg-gold/15 text-ink/60'
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="py-2 text-ink/60">
                  {r.published_at ? new Date(r.published_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selectedId && <TableSetDetail key={selectedId} id={selectedId} />}
    </div>
  );
}

function TableSetDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ table_set: TableSetDTO }>({
    queryKey: ['admin', 'table-set', id],
    queryFn: () => api(`/api/admin/table-sets/${id}`),
  });
  const [editing, setEditing] = useState(false);
  // Per-group JSON drafts, keyed by group name; strings so partial JSON
  // doesn't fight the parser while typing.
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [notesDraft, setNotesDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { payload: unknown; source_notes: TableSetSourceNote[] }) =>
      api(`/api/admin/table-sets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      qc.invalidateQueries({ queryKey: ['admin', 'table-set', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'table-sets'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.message === 'not_a_draft') {
        setError('This set is published and immutable — draft a new version instead.');
      } else {
        setError((e as Error).message);
      }
    },
  });

  if (isLoading) return <div className="text-ink/50">Loading payload…</div>;
  const ts = data?.table_set;
  if (!ts) return null;

  function startEdit() {
    if (!ts) return;
    const drafts: Record<string, string> = {};
    for (const [group, value] of Object.entries(ts.payload)) {
      drafts[group] = JSON.stringify(value, null, 2);
    }
    setGroupDrafts(drafts);
    setNotesDraft(JSON.stringify(ts.source_notes, null, 2));
    setError(null);
    setEditing(true);
  }

  function submit() {
    const payload: Record<string, unknown> = {};
    for (const [group, text] of Object.entries(groupDrafts)) {
      try {
        payload[group] = JSON.parse(text);
      } catch {
        setError(`Group "${group}" is not valid JSON.`);
        return;
      }
    }
    let notes: TableSetSourceNote[];
    try {
      notes = JSON.parse(notesDraft) as TableSetSourceNote[];
      if (!Array.isArray(notes)) throw new Error('not an array');
    } catch {
      setError('Source notes must be a JSON array of {group, authority, url?, note?}.');
      return;
    }
    save.mutate({ payload, source_notes: notes });
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="font-display text-lg">
          {ts.tax_year} v{ts.version}
          <span className="ml-2 text-xs uppercase tracking-wider text-ink/50">{ts.status}</span>
        </div>
        {ts.status === 'draft' && !editing && (
          <button onClick={startEdit} className="px-3 py-1.5 border border-ink/20 rounded text-sm">
            Edit draft
          </button>
        )}
        {editing && (
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={save.isPending}
              className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        )}
      </div>
      {error && (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3">
          {error}
        </div>
      )}
      {Object.entries(ts.payload).map(([group, value]) => (
        <section key={group} className="border border-ink/10 rounded p-4 bg-white">
          <h2 className="font-display text-lg mb-2">{group}</h2>
          {editing ? (
            <textarea
              value={groupDrafts[group] ?? ''}
              onChange={(e) => setGroupDrafts((d) => ({ ...d, [group]: e.target.value }))}
              spellCheck={false}
              aria-label={`${group} JSON`}
              className="w-full text-xs font-mono bg-ink/5 rounded p-3 border border-ink/20 min-h-32"
              rows={Math.min(20, (groupDrafts[group] ?? '').split('\n').length + 1)}
            />
          ) : (
            <pre className="text-xs font-mono overflow-x-auto bg-ink/5 rounded p-3">
              {JSON.stringify(value, null, 2)}
            </pre>
          )}
        </section>
      ))}
      <section className="border border-ink/10 rounded p-4 bg-white">
        <h2 className="font-display text-lg mb-2">Source notes</h2>
        {editing ? (
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            spellCheck={false}
            aria-label="Source notes JSON"
            className="w-full text-xs font-mono bg-ink/5 rounded p-3 border border-ink/20 min-h-32"
            rows={Math.min(20, notesDraft.split('\n').length + 1)}
          />
        ) : (
          <ul className="text-sm space-y-2">
            {ts.source_notes.map((n, i) => (
              <li key={i}>
                <span className="font-medium">{n.group}</span>
                <span className="text-ink/60"> — {n.authority}</span>
                {n.url && (
                  <a
                    href={n.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 underline text-oxblood text-xs"
                  >
                    source
                  </a>
                )}
                {n.note && <div className="text-xs text-ink/50 mt-0.5">{n.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
