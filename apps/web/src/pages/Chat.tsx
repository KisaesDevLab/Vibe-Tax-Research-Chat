// Phase 14-20 — chat page. Composes sidebar + message list + composer + panels.
import { useRef, useState, type FormEvent, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChatSidebar } from '../components/ChatSidebar';
import { Markdown } from '../components/Markdown';
import { CostLedger } from '../components/CostLedger';
import { AuthoritiesPanel } from '../components/panels/AuthoritiesPanel';
import { CompliancePanel } from '../components/panels/CompliancePanel';
import { SkillsPanel } from '../components/panels/SkillsPanel';
import { FollowUpActions } from '../components/panels/FollowUpActions';
import { useChatStream, type StreamingMessage } from '../hooks/useChatStream';
import { api, apiFetch, ApiError } from '../lib/api';
import { extractFollowUpActions, type FollowUpVerb } from '../lib/follow-up';
import { useAppConfig } from '../lib/app-config';
import { ArchiveDialog } from '../components/ArchiveDialog';
import { NudgeBanner } from '../components/NudgeBanner';
import type { ChatDTO, MessageDTO } from '@vibe/shared';

interface AttachmentDTO {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  summary?: string | null;
  ocr_applied?: boolean;
  created_at: string;
}

// File picker accept= filter — mirrors the MIME types the server's parser
// recognizes (lib/parsers/index.ts). Anything outside this list will still
// upload and persist, but the parser will produce empty text and the model
// won't see it. Better to reject up front in the picker.
const ACCEPT_ATTACHMENT_TYPES =
  '.pdf,.docx,.txt,.md,.html,.htm,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/html,application/json,image/png,image/jpeg,image/webp';
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The model emits structured authorities + compliance payloads at the end
// of every research turn so the API can persist them and the panels below
// the prose can render them as formatted document blocks (not JSON walls).
// We strip these payloads from the prose before handing it to Markdown.
//
// We have to handle four shapes the model produces in practice:
//   1. ```json authorities ... ```            (tagged-fence, the spec form)
//   2. ```authorities ... ```                 (no `json` keyword)
//   3. ```json\n{ "authorities": [...] }\n``` (generic JSON fence)
//   4. raw `{ "authorities": [...] }` with no fence at all
// All four occur in the wild because the system prompt asks for fenced
// blocks but the model doesn't always comply. We also have to handle the
// streaming case where the closing fence hasn't arrived yet — treat an
// unclosed authorities/compliance block as already strippable so users
// don't see a half-rendered JSON wall during streaming.

const KEYWORD_RE = /authorities|compliance/i;

function stripSidecars(text: string): string {
  let out = text;

  // Pass 1: fenced blocks. Match a fence that either has authorities/
  // compliance in its info string, OR has an authorities/compliance key
  // in the first ~200 chars of its body. The closing fence is optional
  // (matches end-of-string for in-flight streams).
  out = out.replace(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g, (full, info: string, body: string) => {
    if (KEYWORD_RE.test(info)) return '';
    if (/^[a-z0-9]*$/i.test(info.trim()) && KEYWORD_RE.test(body.slice(0, 200))) return '';
    return full;
  });

  // Pass 2: bare JSON objects (no fence) at the end of the text whose
  // top-level key is "authorities" or "compliance" / "compliance_check".
  // We anchor with a positive look-back for a blank line or start of
  // string to avoid eating an inline `{ "authorities": ... }` mention.
  out = out.replace(
    /(^|\n\s*\n)\s*\{[\s\S]*?"(authorities|compliance|compliance_check)"\s*:[\s\S]*?\}\s*(?=\n\s*\n|\s*$)/g,
    (_full, lead: string) => lead,
  );

  // Pass 3: collapse the trailing whitespace + dividers we leave behind.
  return out
    .replace(/\n[\s-]*\n{2,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function ChatPage() {
  const { chatId } = useParams<{ chatId?: string }>();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  if (!chatId) {
    return (
      <div className="flex h-full overflow-hidden bg-paper">
        <ChatSidebar mobileOpen={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} />
        <div className="flex-1 flex flex-col min-h-0">
          <header className="md:hidden shrink-0 flex items-center px-4 py-3 border-b border-ink/10">
            <MobileSidebarToggle onOpen={() => setMobileSidebarOpen(true)} />
            <div className="ml-3 font-display text-lg">Vibe</div>
          </header>
          <div className="flex-1 grid place-items-center text-ink/50 px-4">
            <div className="text-center">
              <div className="font-display text-2xl mb-2">Start a new research thread</div>
              <div className="text-sm">
                Select &quot;+ New&quot; <span className="md:hidden">from the menu</span>
                <span className="hidden md:inline">in the sidebar</span>.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return <ChatView chatId={chatId} />;
}

// Inline hamburger — only rendered behind a `md:hidden` wrapper, so its
// own classes don't carry that prefix. Kept as its own component so both
// the empty state and the populated chat view share one icon.
function MobileSidebarToggle({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="-ml-1 p-1 text-ink/70 hover:text-ink"
      aria-label="Open chat list"
    >
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}

function ChatView({ chatId }: { chatId: string }) {
  const [draft, setDraft] = useState('');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const { streaming, send, abort, reset } = useChatStream();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // In-flight uploads. They live in local state until the POST resolves;
  // on success we refetch the canonical list and drop the temp row, on
  // failure we keep the row so the user can see what went wrong and
  // dismiss it.
  const [uploads, setUploads] = useState<
    Array<{ tempId: string; filename: string; status: 'uploading' | 'error'; error?: string }>
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // TP-11 — archive-to-client dialog (planning module only).
  const { config } = useAppConfig();
  const [showArchive, setShowArchive] = useState(false);

  const { data, refetch } = useQuery<{ chat: ChatDTO; messages: MessageDTO[] }>({
    queryKey: ['chat', chatId],
    queryFn: () => api(`/api/chats/${chatId}`),
  });

  const { data: attachData, refetch: refetchAttachments } = useQuery<{
    attachments: AttachmentDTO[];
  }>({
    queryKey: ['attachments', chatId],
    queryFn: () => api(`/api/chats/${chatId}/attachments`),
  });
  const attachments = attachData?.attachments ?? [];

  useEffect(() => {
    if (streaming?.done) {
      void refetch();
      reset();
    }
  }, [streaming?.done, refetch, reset]);

  async function uploadOne(file: File): Promise<void> {
    const tempId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploads((u) => [
        ...u,
        {
          tempId,
          filename: file.name,
          status: 'error',
          error: `File is ${formatBytes(file.size)} — limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
        },
      ]);
      return;
    }
    setUploads((u) => [...u, { tempId, filename: file.name, status: 'uploading' }]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // apiFetch handles the auth header + 401-refresh; we deliberately do
      // NOT route this through api() because that helper forces JSON
      // content-type and would clobber the multipart boundary.
      await apiFetch(`/api/chats/${chatId}/attachments`, { method: 'POST', body: fd });
      setUploads((u) => u.filter((x) => x.tempId !== tempId));
      await refetchAttachments();
    } catch (err) {
      const detail =
        err instanceof ApiError
          ? `${err.message} (HTTP ${err.status})`
          : ((err as Error).message ?? 'Upload failed');
      setUploads((u) =>
        u.map((x) => (x.tempId === tempId ? { ...x, status: 'error', error: detail } : x)),
      );
    }
  }

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    setAttachmentError(null);
    for (const file of Array.from(files)) await uploadOne(file);
  }

  async function deleteAttachment(id: string): Promise<void> {
    try {
      await api(`/api/chats/${chatId}/attachments/${id}`, { method: 'DELETE' });
      await refetchAttachments();
    } catch (err) {
      setAttachmentError((err as Error).message ?? 'Delete failed');
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    const text = draft;
    setDraft('');
    await send(chatId, text);
  }

  const provisionalCost = useMemo(() => {
    if (!streaming) return 0;
    const o = streaming.usage.output_tokens ?? streaming.text.length / 4;
    const i = streaming.usage.input_tokens ?? 0;
    return (i * 3 + o * 15) / 1_000_000;
  }, [streaming]);

  return (
    // h-full + overflow-hidden so the sidebar and chat column are each
    // capped at the viewport height granted by AppShell (which owns h-dvh
    // — dvh tracks the *visible* viewport on iOS Safari so the composer
    // doesn't get hidden behind the URL bar). Mobile (<md): sidebar is an
    // off-canvas drawer and the main column takes the full width. md+:
    // sidebar is inline. The chat column is a flex column with min-h-0
    // (the magic that lets a flex child actually scroll instead of
    // forcing the parent taller), header and form are shrink-to-content,
    // and only <main> scrolls between them.
    <div
      className="flex h-full overflow-hidden bg-paper"
      onDragOver={(e) => {
        // Capture drag-over at the chat-column level so users can drop
        // anywhere on the page and have the file land on the active chat.
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor leaves the outer container; child
        // enter/leave events fire constantly and would flicker the overlay.
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(e.dataTransfer.files);
        }
      }}
    >
      <ChatSidebar mobileOpen={mobileSidebarOpen} onClose={() => setMobileSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-h-0 relative">
        {dragOver && (
          <div className="absolute inset-0 z-20 bg-gold/10 border-2 border-dashed border-gold rounded-md grid place-items-center pointer-events-none">
            <div className="font-display text-xl text-ink/70">Drop to attach to this chat</div>
          </div>
        )}
        <header className="shrink-0 px-4 sm:px-6 md:px-7 py-3 md:py-4 border-b border-ink/10 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen(true)}
            className="md:hidden -ml-1 p-1 text-ink/70 hover:text-ink"
            aria-label="Open chat list"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="font-display text-base md:text-lg truncate flex-1 min-w-0">
            {data?.chat.title ?? 'Loading…'}
          </div>
          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            {config.planning_enabled && data?.chat && (
              <button
                type="button"
                onClick={() => setShowArchive(true)}
                className="text-xs px-2 py-1 border border-ink/20 rounded hover:bg-ink/5"
                title="Freeze an immutable snapshot and file it to a client"
              >
                Archive…
              </button>
            )}
            <ReferenceLibraryToggle chat={data?.chat} onChange={() => void refetch()} />
            <div className="font-mono text-xs text-ink/50 hidden sm:block">
              {data?.messages.length ?? 0} messages
            </div>
          </div>
        </header>
        {config.planning_enabled && (
          <NudgeBanner chatId={chatId} onArchiveClick={() => setShowArchive(true)} />
        )}
        {showArchive && data?.chat && (
          <ArchiveDialog chat={data.chat} onClose={() => setShowArchive(false)} />
        )}

        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-4 sm:px-6 md:px-7 py-6 max-w-4xl w-full">
            {(() => {
              // Walk the messages forward and remember each system_note's
              // immediately-preceding user message. That's what the
              // "Re-send question" button replays — a user-friendly retry
              // for the recovery / abort / error system_notes the server
              // emits at the bottom of broken turns.
              const msgs = data?.messages ?? [];
              let lastUserContent: string | null = null;
              return msgs.map((m) => {
                if (m.role === 'user') lastUserContent = m.content;
                const priorUser = m.role === 'system_note' ? lastUserContent : null;
                return (
                  <MessageBlock
                    key={m.id}
                    message={m}
                    priorUserContent={priorUser}
                    onResend={(text) => void send(chatId, text)}
                    onFollowUp={(verb) => void send(chatId, verb)}
                  />
                );
              });
            })()}
            {streaming && (
              <>
                {/*
                  Optimistic user-message echo. The persisted user-message
                  row only appears on refetch (after `done`), so without
                  this block users see their textarea clear and then
                  silence for a few seconds while the model thinks. Mirrors
                  the styling of the persisted "You" block in MessageBlock.
                */}
                {streaming.user_message && (
                  <div className="mb-4">
                    <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
                    <div className="bg-ink/5 rounded p-3 font-body whitespace-pre-wrap">
                      {streaming.user_message}
                    </div>
                  </div>
                )}
                <div className="mb-6 space-y-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="text-xs uppercase tracking-wider text-ink/50">Assistant</div>
                    <StreamingStatus streaming={streaming} />
                  </div>
                  {streaming.text ? (
                    <Markdown>{stripSidecars(streaming.text)}</Markdown>
                  ) : (
                    <div className="text-sm text-ink/50 italic">
                      Working on it{streaming.tool_uses.length === 0 ? '…' : ''}
                    </div>
                  )}
                  <CostLedger
                    usage={streaming.usage}
                    cost_usd={streaming.cost ?? provisionalCost}
                    model_id={data?.chat.default_model_id ?? undefined}
                    provisional={!streaming.done}
                  />
                  {streaming.error && (
                    <div className="text-oxblood text-sm mt-2">{streaming.error}</div>
                  )}
                  {streaming.done &&
                    (() => {
                      // The persisted message that takes over after refetch
                      // will render its own chips. This brief render covers
                      // the gap between `done` flipping and refetch landing,
                      // so the user never sees an answer without follow-ups.
                      const actions = extractFollowUpActions(streaming.text);
                      if (!actions) return null;
                      return (
                        <FollowUpActions
                          verbs={actions.verbs}
                          conclusionEcho={actions.conclusionEcho}
                          onPick={(verb) => void send(chatId, verb)}
                        />
                      );
                    })()}
                </div>
              </>
            )}
          </div>
        </main>

        <form
          onSubmit={onSubmit}
          className="shrink-0 px-4 sm:px-6 md:px-7 py-3 md:py-4 border-t border-ink/10 bg-paper"
        >
          <div className="max-w-4xl w-full">
            {(attachments.length > 0 || uploads.length > 0 || attachmentError) && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {attachments.map((a) => (
                  <AttachmentChip
                    key={a.id}
                    filename={a.filename}
                    sizeBytes={a.size_bytes}
                    onRemove={() => void deleteAttachment(a.id)}
                  />
                ))}
                {uploads.map((u) => (
                  <PendingChip
                    key={u.tempId}
                    filename={u.filename}
                    status={u.status}
                    error={u.error}
                    onDismiss={() => setUploads((cur) => cur.filter((x) => x.tempId !== u.tempId))}
                  />
                ))}
                {attachmentError && (
                  <div className="text-xs text-oxblood flex items-center gap-2">
                    <span>{attachmentError}</span>
                    <button
                      type="button"
                      onClick={() => setAttachmentError(null)}
                      className="underline"
                    >
                      dismiss
                    </button>
                  </div>
                )}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTACHMENT_TYPES}
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  void uploadFiles(e.target.files);
                  // Reset the input so picking the same file twice still fires onChange.
                  e.target.value = '';
                }
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-2 border border-ink/20 rounded text-ink/60 hover:text-ink hover:border-ink/40"
                title="Attach a file (PDF, DOCX, TXT, MD, HTML)"
              >
                {/* Inline paperclip — avoids pulling in an icon package for one glyph. */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Ask a tax research question…"
                rows={3}
                className="flex-1 px-3 py-2 border border-ink/20 rounded font-body resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void onSubmit(e);
                }}
              />
              {streaming && !streaming.done ? (
                <button
                  type="button"
                  onClick={abort}
                  className="px-4 py-2 border border-oxblood text-oxblood rounded"
                >
                  Stop
                </button>
              ) : (
                <button type="submit" className="px-4 py-2 bg-ink text-paper rounded">
                  Send
                </button>
              )}
            </div>
            <div className="text-[10px] text-ink/40 mt-1">
              ⌘/Ctrl + Enter to send · drop files anywhere to attach
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// Phase 32 — per-chat toggle for the firm reference library. Default is
// on when the chat was created; researchers flip it off for memo-writing
// turns where they want primary-authority citations only. Hidden until
// the chat row has loaded so the initial render doesn't flash a default
// state that contradicts the persisted value.
function ReferenceLibraryToggle({
  chat,
  onChange,
}: {
  chat: ChatDTO | undefined;
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const mutate = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/chats/${chat!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ use_reference_library: next }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chat', chat!.id] });
      onChange();
    },
  });
  if (!chat) return null;
  const on = chat.use_reference_library;
  return (
    <button
      type="button"
      onClick={() => mutate.mutate(!on)}
      disabled={mutate.isPending}
      title={
        on
          ? 'Firm reference library is being consulted on every turn. Click to disable for this chat.'
          : 'Firm reference library is OFF for this chat. Click to re-enable.'
      }
      className={`text-xs px-2 py-1 rounded border transition-colors ${
        on ? 'border-ink/30 bg-ink/5 text-ink' : 'border-ink/20 text-ink/40 hover:text-ink/60'
      }`}
    >
      <span className="font-mono mr-1">{on ? '●' : '○'}</span>
      Reference library
    </button>
  );
}

function AttachmentChip({
  filename,
  sizeBytes,
  onRemove,
}: {
  filename: string;
  sizeBytes: number;
  onRemove: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-2 bg-ink/5 border border-ink/10 rounded px-2 py-1 text-xs">
      <span className="font-mono truncate max-w-[14rem]" title={filename}>
        {filename}
      </span>
      <span className="text-ink/40">{formatBytes(sizeBytes)}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-ink/40 hover:text-oxblood ml-0.5"
        title="Remove attachment"
        aria-label="Remove attachment"
      >
        ×
      </button>
    </div>
  );
}

function PendingChip({
  filename,
  status,
  error,
  onDismiss,
}: {
  filename: string;
  status: 'uploading' | 'error';
  error?: string;
  onDismiss: () => void;
}) {
  if (status === 'error') {
    return (
      <div
        className="inline-flex items-center gap-2 bg-oxblood/5 border border-oxblood/30 rounded px-2 py-1 text-xs text-oxblood"
        title={error}
      >
        <span className="font-mono truncate max-w-[14rem]">{filename}</span>
        <span className="text-oxblood/70">failed</span>
        <button type="button" onClick={onDismiss} className="ml-0.5" aria-label="Dismiss">
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 rounded px-2 py-1 text-xs">
      <span className="font-mono truncate max-w-[14rem]">{filename}</span>
      <span className="text-ink/50">uploading…</span>
    </div>
  );
}

// Live status line for the streaming assistant turn. Three layers of info:
//   1. an animated dot to signal "still working"
//   2. a short narration of what's happening right now ("Searching irs.gov",
//      "Running code", "Drafting answer")
//   3. an elapsed timer that ticks every second so the user can tell the
//      request hasn't stalled
function StreamingStatus({ streaming }: { streaming: StreamingMessage }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (streaming.done) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [streaming.done]);

  const elapsedSec = Math.max(0, Math.floor((Date.now() - streaming.started_at) / 1000));
  const narration = describeActivity(streaming);

  return (
    <div className="text-xs text-ink/60 flex items-center gap-2 whitespace-nowrap">
      {!streaming.done && (
        <span className="inline-flex h-2 w-2 rounded-full bg-moss animate-pulse" aria-hidden />
      )}
      <span>{streaming.done ? 'Finished' : narration}</span>
      <span className="text-ink/30">·</span>
      <span className="font-mono">{elapsedSec}s</span>
    </div>
  );
}

function describeActivity(streaming: StreamingMessage): string {
  if (streaming.error) return 'Errored';
  // Most recent in-flight tool use wins; fallback to "Drafting" once text
  // has started flowing, otherwise "Thinking".
  const open = [...streaming.tool_uses].reverse().find((t) => !t.status);
  if (open) {
    if (open.tool_name === 'web_fetch') {
      const url = (open.input as { url?: string } | null)?.url;
      const host = url ? safeHost(url) : null;
      return host ? `Fetching ${host}` : 'Fetching source';
    }
    if (open.tool_name === 'web_search') {
      const q = (open.input as { query?: string } | null)?.query;
      return q ? `Searching: ${q.slice(0, 60)}` : 'Searching the web';
    }
    if (open.tool_name === 'code_execution') return 'Running code';
    return `Running ${open.tool_name}`;
  }
  if (streaming.text.length > 0) return 'Drafting answer';
  return 'Thinking';
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function MessageBlock({
  message: m,
  priorUserContent,
  onResend,
  onFollowUp,
}: {
  message: MessageDTO;
  priorUserContent?: string | null;
  onResend?: (text: string) => void;
  onFollowUp?: (verb: FollowUpVerb) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
        <div className="bg-ink/5 rounded p-3 font-body">{m.content}</div>
      </div>
    );
  }
  if (m.role === 'system_note') {
    // Recovery / abort / error system_notes typically end with a hint to
    // re-send the question. When we have the immediately-preceding user
    // message in hand, surface a one-click "Re-send question" button so
    // the admin doesn't have to hunt for or retype it.
    const looksRecoverable =
      /re-?send|connection lost|server restart|retry/i.test(m.content) &&
      typeof priorUserContent === 'string' &&
      priorUserContent.length > 0 &&
      typeof onResend === 'function';
    return (
      <div className="my-3 text-xs text-ink/50 italic flex items-baseline gap-3">
        <span>{m.content}</span>
        {looksRecoverable && (
          <button
            type="button"
            onClick={() => onResend!(priorUserContent!)}
            className="not-italic text-ink/80 underline underline-offset-2 hover:text-ink whitespace-nowrap"
          >
            Re-send question
          </button>
        )}
      </div>
    );
  }
  return (
    // Wrap the assistant body + panels in a vertical-rhythm container so
    // every block (Markdown prose, Authorities, Compliance, Skills, Cost)
    // gets the same 12px gap. Reduces the previous mish-mash of mt-4 +
    // implicit margin into a single uniform stack.
    //
    // `data-pdf-target` marks the block the PDF exporter should capture.
    // We capture only the panels we want in the export (Markdown body +
    // Authorities + Compliance), wrapped in a child element with that
    // attribute, so the toolbar / cost ledger don't end up in the PDF.
    // `data-message-id` lets the exporter scope the query to the right
    // message when a chat has many turns.
    <div className="mb-6 space-y-3" data-message-id={m.id}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs uppercase tracking-wider text-ink/50">Assistant</div>
        <MessageActions message={m} />
      </div>
      <div data-pdf-target="response" className="space-y-3">
        <Markdown>{stripSidecars(m.content)}</Markdown>
        <AuthoritiesPanel authorities={(m.authorities as never) ?? []} />
        <CompliancePanel check={m.compliance_check} />
      </div>
      <SkillsPanel skills={m.skills} />
      <CostLedger usage={m.usage} cost_usd={m.cost_usd} model_id={m.model_id} />
      {(() => {
        const actions = extractFollowUpActions(m.content);
        if (!actions || !onFollowUp) return null;
        return (
          <FollowUpActions
            verbs={actions.verbs}
            conclusionEcho={actions.conclusionEcho}
            onPick={onFollowUp}
          />
        );
      })()}
    </div>
  );
}

// ── Per-message export tools ──────────────────────────────────────────────
// Copy puts a clean Markdown rendering on the clipboard (sans sidecar
// JSON). PDF opens a popup window with the same content laid out for
// print and triggers the browser's print dialog — the user picks
// "Save as PDF" from there. No PDF library to ship.
function MessageActions({ message: m }: { message: MessageDTO }) {
  const [copied, setCopied] = useState(false);
  const messageId = m.id;

  const exportMd = useMemo(() => buildExportMarkdown(m), [m]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportMd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for browsers / contexts where clipboard is blocked.
      const ta = document.createElement('textarea');
      ta.value = exportMd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const onPdf = async () => {
    setPdfBusy(true);
    try {
      await downloadMessagePdf(m, messageId);
    } catch (err) {
      console.error('pdf export failed', err);
      // The api returns `{ error: 'pdf_generation_failed', detail: <msg> }`.
      // ApiError sets .message from `error` only, so the actual diagnostic
      // (e.g., "Cannot read properties of undefined", "stack overflow")
      // lives on .body.detail. Surface both so the user can paste the real
      // message into a bug report.
      const e = err as Error & { body?: { detail?: string } };
      const detail = e.body?.detail ? `\n\n${e.body.detail}` : '';
      alert(`PDF export failed: ${e.message}${detail}`);
    } finally {
      setPdfBusy(false);
    }
  };
  const [docxBusy, setDocxBusy] = useState(false);
  const onDocx = async () => {
    setDocxBusy(true);
    try {
      await downloadMessageDocx(m, messageId);
    } catch (err) {
      console.error('docx export failed', err);
      const e = err as Error & { body?: { detail?: string } };
      const detail = e.body?.detail ? `\n\n${e.body.detail}` : '';
      alert(`DOCX export failed: ${e.message}${detail}`);
    } finally {
      setDocxBusy(false);
    }
  };
  const [xlsxBusy, setXlsxBusy] = useState(false);
  const onXlsx = async () => {
    setXlsxBusy(true);
    try {
      await downloadMessageXlsx(m, messageId);
    } catch (err) {
      console.error('xlsx export failed', err);
      const e = err as Error & { body?: { detail?: string } };
      const detail = e.body?.detail ? `\n\n${e.body.detail}` : '';
      alert(`XLSX export failed: ${e.message}${detail}`);
    } finally {
      setXlsxBusy(false);
    }
  };
  // exportMd is consumed by onCopy; reference here so TS doesn't flag it
  // as unused-after-refactor when the PDF path moved to the server.
  void exportMd;

  return (
    <div className="text-xs flex items-center gap-3">
      <button
        type="button"
        onClick={onCopy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline"
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      <button
        type="button"
        onClick={onPdf}
        disabled={pdfBusy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
        title="Download a formatted PDF of this response"
      >
        {pdfBusy ? 'Building PDF…' : 'Download PDF'}
      </button>
      <button
        type="button"
        onClick={onDocx}
        disabled={docxBusy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
        title="Download an editable Word document of this response"
      >
        {docxBusy ? 'Building DOCX…' : 'Download DOCX'}
      </button>
      <button
        type="button"
        onClick={onXlsx}
        disabled={xlsxBusy}
        className="text-ink/50 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
        title="Download an Excel workpaper of this response (calculation worksheet when produced by excel-workpaper-builder; otherwise a prose dump)"
      >
        {xlsxBusy ? 'Building XLSX…' : 'Download XLSX'}
      </button>
    </div>
  );
}

function buildExportMarkdown(m: MessageDTO): string {
  const lines: string[] = [];
  lines.push(stripSidecars(m.content).trim());

  const auths = (m.authorities ?? []) as Array<{
    cite: string;
    type?: string;
    weight?: string;
    source?: string;
    verified_this_turn?: boolean;
  }>;
  if (auths.length > 0) {
    lines.push('', '## Authorities');
    auths.forEach((a, i) => {
      const status = a.verified_this_turn ? '✓ verified' : 'unverified';
      const meta = [a.type, a.weight ? `weight: ${a.weight}` : null].filter(Boolean).join(' · ');
      lines.push(`${i + 1}. **${a.cite}** — ${status}`);
      if (meta) lines.push(`   ${meta}`);
      if (a.source) lines.push(`   ${a.source}`);
    });
  }

  const c = m.compliance_check as Record<string, unknown> | null | undefined;
  if (c) {
    lines.push('', '## Compliance');
    if (typeof c.engagement_type === 'string') lines.push(`**Engagement:** ${c.engagement_type}`);
    if (typeof c.confidence_band === 'string') lines.push(`**Confidence:** ${c.confidence_band}`);
    if (typeof c.notes === 'string') lines.push('', c.notes);
  }

  if (m.cost_usd != null) {
    lines.push(
      '',
      '---',
      `_Generated by Vibe Tax Research · model: ${m.model_id ?? 'unknown'} · cost: $${Number(m.cost_usd).toFixed(4)}_`,
    );
  }
  return lines.join('\n');
}

// Fetch the server-rendered PDF and trigger a browser download. The
// server uses PDFKit to emit a real, selectable-text PDF. apiFetch()
// handles the same auth + refresh-on-401 flow the rest of the SPA
// uses — without it, a stale 15-minute access token would 401 here
// even when the SPA is otherwise authenticated.
async function downloadMessagePdf(m: MessageDTO, messageId: string): Promise<void> {
  await downloadMessageExport(m, messageId, 'pdf');
}

async function downloadMessageDocx(m: MessageDTO, messageId: string): Promise<void> {
  await downloadMessageExport(m, messageId, 'docx');
}

async function downloadMessageXlsx(m: MessageDTO, messageId: string): Promise<void> {
  await downloadMessageExport(m, messageId, 'xlsx');
}

// Shared PDF/DOCX/XLSX download helper. Same auth, same content-
// disposition parsing, same blob-URL cleanup — only the path suffix
// and the fallback extension differ.
async function downloadMessageExport(
  m: MessageDTO,
  messageId: string,
  kind: 'pdf' | 'docx' | 'xlsx',
): Promise<void> {
  const res = await apiFetch(`/api/chats/${m.chat_id}/messages/${messageId}/${kind}`);
  const blob = await res.blob();
  let filename = '';
  const cd = res.headers.get('content-disposition') ?? '';
  const match = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  if (match) filename = match[1]!;
  if (!filename) {
    const stamp = new Date(m.created_at).toISOString().slice(0, 10);
    filename = `vibe-tax-research-${stamp}-${m.id.slice(0, 8)}.${kind}`;
  }
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the blob URL on the next tick — Safari needs the click to
  // complete before the URL can be revoked.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
