// TP-11 — "Archive to client…" dialog. Flow: fetch the draft (Claude-
// suggested title/tags where a key is configured, PII hits always), let
// the user pick the destination (client picker defaulting chat.client_id
// → active chip → firm archive), edit title/tags/note, review PII hits
// with one-click redaction, then freeze the snapshot.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArchiveDraftResponse, ChatDTO, ClientDTO, PiiHitDTO, PlanDTO } from '@vibe/shared';
import { api } from '../lib/api';
import { useActiveClient } from '../lib/active-client';

interface ArchiveDialogProps {
  chat: ChatDTO;
  onClose: () => void;
  onArchived?: () => void;
}

export function ArchiveDialog({ chat, onClose, onArchived }: ArchiveDialogProps) {
  const qc = useQueryClient();
  const { activeClient } = useActiveClient();

  const { data: draft, isLoading: drafting } = useQuery<ArchiveDraftResponse>({
    queryKey: ['archive-draft', chat.id],
    queryFn: () => api(`/api/chats/${chat.id}/archive/draft`, { method: 'POST' }),
    staleTime: Infinity,
  });

  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [note, setNote] = useState('');
  const [firmArchive, setFirmArchive] = useState(false);
  const [clientId, setClientId] = useState<string | null>(
    chat.client_id ?? activeClient?.id ?? null,
  );
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // TP-8 — optional plan/strategy link (same-client plans only).
  const [planId, setPlanId] = useState<string | null>(null);
  const [strategyId, setStrategyId] = useState('');
  const { data: plansData } = useQuery<{ plans: PlanDTO[] }>({
    queryKey: ['plans', { client: clientId ?? 'none' }],
    queryFn: () => api(`/api/planning/plans?client_id=${clientId}`),
    enabled: Boolean(clientId) && !firmArchive,
  });

  // Hydrate once the draft lands: suggested title/tags, all PII hits
  // pre-accepted (the safe default — unchecking is the explicit act).
  useEffect(() => {
    if (!draft) return;
    setTitle((t) => t || draft.suggested_title);
    setTags((t) => (t.length > 0 ? t : draft.suggested_tags));
    setAcceptedIds(new Set(draft.pii_hits.map((h) => h.id)));
  }, [draft]);

  const archive = useMutation({
    mutationFn: () =>
      api(`/api/chats/${chat.id}/archive`, {
        method: 'POST',
        body: JSON.stringify({
          client_id: firmArchive ? null : clientId,
          firm_archive: firmArchive,
          title: title.trim(),
          topic_tags: tags.slice(0, 6),
          note: note.trim() || null,
          accepted_redaction_ids: Array.from(acceptedIds),
          plan_id: planId,
          strategy_id: strategyId.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats'] });
      qc.invalidateQueries({ queryKey: ['chat', chat.id] });
      onArchived?.();
      onClose();
    },
    onError: (err) => setError((err as Error).message),
  });

  const hits = draft?.pii_hits ?? [];
  const canSubmit = title.trim().length > 0 && tags.length >= 1 && (firmArchive || clientId);

  function addTag() {
    const t = tagDraft.trim();
    if (!t || tags.includes(t) || tags.length >= 6) return;
    setTags([...tags, t]);
    setTagDraft('');
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 grid place-items-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h2 className="font-display text-xl mb-1">Archive to client…</h2>
        <p className="text-sm text-ink/60 mb-4">
          Freezes an immutable snapshot of this session (transcript, citations, source
          consultations) and files it under a client.
        </p>

        {drafting ? (
          <div className="text-ink/50 py-6 text-center">Preparing draft…</div>
        ) : (
          <>
            <div className="mb-3">
              <span className="text-sm text-ink/60 block mb-1">File under</span>
              <ClientSelect
                disabled={firmArchive}
                value={clientId}
                onChange={setClientId}
                defaultName={
                  chat.client_id
                    ? undefined
                    : activeClient && clientId === activeClient.id
                      ? activeClient.name
                      : undefined
                }
              />
              <label className="flex items-center gap-2 text-sm mt-2">
                <input
                  type="checkbox"
                  checked={firmArchive}
                  onChange={(e) => setFirmArchive(e.target.checked)}
                />
                <span>Firm-level archive (no client)</span>
              </label>
            </div>

            <label className="block text-sm mb-3">
              <span className="text-ink/60">Title</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-ink/20 rounded text-sm"
              />
            </label>

            <div className="mb-3">
              <span className="text-sm text-ink/60 block mb-1">Topic tags (1–6)</span>
              <div className="flex flex-wrap gap-1 mb-1">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-ink/5 border border-ink/15 rounded-full text-xs"
                  >
                    {t}
                    <button
                      type="button"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => setTags(tags.filter((x) => x !== t))}
                      className="text-ink/40 hover:text-ink"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder="Add a tag and press Enter"
                className="w-full px-3 py-1.5 border border-ink/20 rounded text-sm"
              />
            </div>

            <label className="block text-sm mb-3">
              <span className="text-ink/60">Note (optional)</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="mt-1 w-full px-3 py-2 border border-ink/20 rounded text-sm"
              />
            </label>

            {!firmArchive && (plansData?.plans.length ?? 0) > 0 && (
              <div className="mb-3 grid grid-cols-2 gap-2">
                <label className="block text-sm">
                  <span className="text-ink/60">Link to plan (optional)</span>
                  <select
                    value={planId ?? ''}
                    onChange={(e) => setPlanId(e.target.value || null)}
                    className="mt-1 w-full px-2 py-1.5 border border-ink/20 rounded text-sm bg-white"
                  >
                    <option value="">none</option>
                    {plansData!.plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-ink/60">Strategy slug (optional)</span>
                  <input
                    value={strategyId}
                    onChange={(e) => setStrategyId(e.target.value)}
                    placeholder="e.g. reasonable-comp-study"
                    disabled={!planId}
                    className="mt-1 w-full px-2 py-1.5 border border-ink/20 rounded text-sm"
                  />
                </label>
              </div>
            )}

            {hits.length > 0 && (
              <PiiPanel hits={hits} acceptedIds={acceptedIds} onChange={setAcceptedIds} />
            )}

            {error && <div className="text-oxblood text-sm mb-3">{error}</div>}
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 border border-ink/20 rounded text-sm"
              >
                Cancel
              </button>
              <button
                disabled={!canSubmit || archive.isPending}
                onClick={() => archive.mutate()}
                className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
              >
                {archive.isPending ? 'Archiving…' : 'Archive session'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PiiPanel({
  hits,
  acceptedIds,
  onChange,
}: {
  hits: PiiHitDTO[];
  acceptedIds: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const allAccepted = hits.every((h) => acceptedIds.has(h.id));
  return (
    <div className="mb-3 border border-oxblood/40 rounded p-3 bg-oxblood/5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-oxblood">
          {hits.length} possible identifier{hits.length === 1 ? '' : 's'} detected
        </span>
        <button
          type="button"
          onClick={() => onChange(allAccepted ? new Set() : new Set(hits.map((h) => h.id)))}
          className="text-xs underline text-oxblood"
        >
          {allAccepted ? 'Keep all' : 'Redact all'}
        </button>
      </div>
      <ul className="space-y-1 max-h-40 overflow-y-auto">
        {hits.map((h) => (
          <li key={h.id} className="text-xs flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acceptedIds.has(h.id)}
              onChange={(e) => {
                const next = new Set(acceptedIds);
                if (e.target.checked) next.add(h.id);
                else next.delete(h.id);
                onChange(next);
              }}
            />
            <span>
              <span className="uppercase font-mono text-[10px] text-oxblood mr-1">{h.kind}</span>
              <span className="font-mono">{h.match}</span>
              <span className="text-ink/40 block truncate max-w-[360px]">…{h.context}…</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="text-[11px] text-ink/50 mt-2">
        Checked items are replaced with [REDACTED-…] before the snapshot freezes.
      </div>
    </div>
  );
}

// Compact inline client selector: search + pick.
function ClientSelect({
  value,
  onChange,
  disabled,
  defaultName,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  defaultName?: string;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data } = useQuery<{ clients: ClientDTO[] }>({
    queryKey: ['clients', { q: debounced }],
    queryFn: () => api(`/api/clients?q=${encodeURIComponent(debounced)}`),
    enabled: !disabled,
  });
  const rows = data?.clients ?? [];
  const selected = rows.find((c) => c.id === value);

  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={
          selected?.name ?? defaultName ?? (value ? 'Linked client selected' : 'Search clients…')
        }
        className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
      />
      {debounced && (
        <div className="border border-ink/10 rounded mt-1 max-h-36 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink/40">No clients found.</div>
          ) : (
            rows.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange(c.id);
                  setQ('');
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-ink/5 ${
                  value === c.id ? 'bg-ink/10' : ''
                }`}
              >
                {c.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
