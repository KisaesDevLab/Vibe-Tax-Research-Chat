// TP-3a/TP-6a — extraction-candidate review, shared between the client
// Facts tab and the plan tie-out Facts sub-tab (planId prop). Conflict
// groups render first, side-by-side, pick-one; everything else is grouped
// by section with accept/edit/reject per row. Submitting resolves in one
// transaction server-side (new client version + optional plan snapshot).
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConflictGroup, DocumentCandidateDTO } from '@vibe/shared';
import { api, ApiError } from '../../../lib/api';
import { openDocumentAtPage } from './SourceBadge';

type Action = 'accept' | 'reject';

interface CandidatesResponse {
  candidates: DocumentCandidateDTO[];
  conflicts: ConflictGroup[];
}

function candidateKey(c: DocumentCandidateDTO): string {
  return `${c.document_id}:${c.candidate.id}`;
}

function valueLabel(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function CandidateReview({
  clientId,
  planId,
  onDone,
}: {
  clientId: string;
  planId?: string;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [actions, setActions] = useState<Map<string, Action>>(new Map());
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<CandidatesResponse>({
    queryKey: ['client-fact-candidates', clientId],
    queryFn: () => api(`/api/clients/${clientId}/facts/candidates`),
  });

  const conflictKeys = useMemo(() => {
    const set = new Set<string>();
    for (const g of data?.conflicts ?? []) for (const c of g.candidates) set.add(candidateKey(c));
    return set;
  }, [data]);

  const nonConflict = (data?.candidates ?? []).filter((c) => !conflictKeys.has(candidateKey(c)));
  const bySection = useMemo(() => {
    const m = new Map<string, DocumentCandidateDTO[]>();
    for (const c of nonConflict) {
      const list = m.get(c.candidate.section) ?? [];
      list.push(c);
      m.set(c.candidate.section, list);
    }
    return m;
  }, [nonConflict]);

  const resolve = useMutation({
    mutationFn: () => {
      const resolutions = [...actions.entries()].map(([key, action]) => {
        const [document_id, candidate_id] = key.split(':') as [string, string];
        const edited = edits.get(key);
        return {
          document_id,
          candidate_id,
          action,
          ...(action === 'accept' && edited !== undefined && edited !== ''
            ? { edited_value: maybeParse(edited) }
            : {}),
        };
      });
      return api(`/api/clients/${clientId}/facts/candidates/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          resolutions,
          ...(summary.trim() ? { change_summary: summary.trim() } : {}),
          ...(planId ? { plan_id: planId } : {}),
        }),
      });
    },
    onSuccess: () => {
      setError(null);
      setActions(new Map());
      setEdits(new Map());
      setSummary('');
      void qc.invalidateQueries({ queryKey: ['client-facts', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-fact-versions', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-fact-candidates', clientId] });
      if (planId) void qc.invalidateQueries({ queryKey: ['plan-fact-snapshots', planId] });
      onDone?.();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.message === 'plan_frozen') {
        setError('This plan is frozen — candidates can no longer attach a snapshot to it.');
      } else if (err instanceof ApiError && err.message === 'candidate_already_resolved') {
        setError('Someone else already resolved one of these candidates — refresh the list.');
      } else if (err instanceof ApiError && err.message === 'invalid_facts') {
        setError('An accepted value does not fit the fact schema — check edited values.');
      } else {
        setError('Resolve failed — try again.');
      }
    },
  });

  function maybeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function setAction(key: string, action: Action | null) {
    setActions((prev) => {
      const next = new Map(prev);
      if (action === null) next.delete(key);
      else next.set(key, action);
      return next;
    });
  }

  function pickConflictWinner(group: ConflictGroup, winner: DocumentCandidateDTO) {
    setActions((prev) => {
      const next = new Map(prev);
      for (const c of group.candidates) {
        next.set(candidateKey(c), c === winner ? 'accept' : 'reject');
      }
      return next;
    });
  }

  if (isLoading) return <div className="text-ink/50 text-sm">Loading candidates…</div>;
  const total = data?.candidates.length ?? 0;
  if (total === 0) {
    return (
      <div className="text-ink/50 border border-dashed border-ink/20 rounded p-6 text-center text-sm">
        No pending extracted facts. Upload a document to generate candidates.
      </div>
    );
  }

  const decided = actions.size;

  function CandidateRow({ item }: { item: DocumentCandidateDTO }) {
    const key = candidateKey(item);
    const action = actions.get(key) ?? null;
    const src = item.candidate.sources[0];
    return (
      <div className="flex items-start gap-3 py-1.5 border-b border-ink/5 text-sm">
        <div className="flex gap-1 shrink-0 pt-0.5">
          <button
            onClick={() => setAction(key, action === 'accept' ? null : 'accept')}
            className={`px-1.5 py-0.5 rounded text-xs border ${
              action === 'accept'
                ? 'bg-moss text-paper border-moss'
                : 'border-ink/20 hover:bg-ink/5'
            }`}
          >
            Accept
          </button>
          <button
            onClick={() => setAction(key, action === 'reject' ? null : 'reject')}
            className={`px-1.5 py-0.5 rounded text-xs border ${
              action === 'reject'
                ? 'bg-oxblood text-paper border-oxblood'
                : 'border-ink/20 hover:bg-ink/5'
            }`}
          >
            Reject
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <div>{item.candidate.display}</div>
          <div className="text-xs text-ink/40 font-mono truncate">
            {item.candidate.path} = {valueLabel(item.candidate.value)}
          </div>
          {action === 'accept' && (
            <input
              className="mt-1 border border-ink/20 rounded px-2 py-0.5 text-xs w-full font-mono"
              placeholder="Edit value (optional — JSON or plain text)"
              value={edits.get(key) ?? ''}
              onChange={(e) => setEdits((prev) => new Map(prev).set(key, e.target.value))}
            />
          )}
        </div>
        {src && (
          <button
            onClick={() => void openDocumentAtPage(clientId, src.documentId, src.page)}
            className="text-xs text-moss underline shrink-0"
            title={item.filename}
          >
            {item.filename} p.{src.page}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(data?.conflicts ?? []).length > 0 && (
        <div className="border border-gold/60 rounded p-3 bg-gold/5">
          <div className="text-sm font-medium mb-2">
            Conflicting values — pick one per fact (the rest reject)
          </div>
          {data!.conflicts.map((group) => (
            <div key={group.path} className="mb-3">
              <div className="text-xs font-mono text-ink/60 mb-1">{group.path}</div>
              <div className="grid gap-2 md:grid-cols-2">
                {group.candidates.map((item) => {
                  const key = candidateKey(item);
                  const picked = actions.get(key) === 'accept';
                  return (
                    <label
                      key={key}
                      className={`border rounded p-2 text-sm cursor-pointer ${
                        picked ? 'border-moss bg-moss/5' : 'border-ink/15 bg-white'
                      }`}
                    >
                      <input
                        type="radio"
                        name={`conflict-${group.path}`}
                        checked={picked}
                        onChange={() => pickConflictWinner(group, item)}
                        className="mr-2"
                      />
                      {item.candidate.display}
                      <div className="text-xs text-ink/40 mt-0.5">
                        {item.filename}
                        {item.candidate.sources[0] ? ` p.${item.candidate.sources[0].page}` : ''}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {[...bySection.entries()].map(([section, items]) => (
        <div key={section} className="border border-ink/10 rounded p-3 bg-white">
          <div className="text-[11px] uppercase tracking-wider text-ink/40 mb-1">{section}</div>
          {items.map((item) => (
            <CandidateRow key={candidateKey(item)} item={item} />
          ))}
        </div>
      ))}

      <div className="border-t border-ink/10 pt-3 flex items-center gap-3">
        <input
          className="border border-ink/20 rounded px-2 py-1.5 text-sm flex-1"
          placeholder="Change summary (auto-drafted if left blank)"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <button
          onClick={() => resolve.mutate()}
          disabled={decided === 0 || resolve.isPending}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50 shrink-0"
        >
          Apply {decided}/{total}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm">{error}</div>}
    </div>
  );
}
