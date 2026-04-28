// Phase 21 follow-up — custom-skill drawer: fields + Claude refinement chat.
//
// The drawer drives create AND edit:
//   - Create (no id): all fields editable; slug enabled.
//   - Edit (id present): slug locked (changing it would orphan the
//     already-uploaded Anthropic skill).
//
// The right-side chat panel calls POST /api/admin/custom-skills/refine.
// The endpoint returns Claude's prose reply plus a list of proposed
// field updates (tool-use). Updates are NOT applied automatically — they
// render as cards with Apply / Discard buttons. The conversation lives
// in component state and is wiped on close.
import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { api, ApiError } from '../../lib/api';

export interface DrawerSource {
  filename: string;
  full_text: string;
}

export interface DrawerState {
  id?: string;
  name: string;
  display_name: string;
  description: string;
  body: string;
  routing_keywords: string[];
  source?: DrawerSource;
  include_source_as_reference: boolean;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

type FieldUpdate =
  | { kind: 'replace'; field: 'display_name' | 'description' | 'body_md'; value: string }
  | { kind: 'replace'; field: 'routing_keywords'; value: string[] }
  | { kind: 'append'; field: 'body_md'; value: string }
  | { kind: 'append'; field: 'routing_keywords'; value: string[] };

interface RefineResponse {
  reply_text: string;
  updates: FieldUpdate[];
}

export interface SaveResult {
  ok: boolean;
}

export interface CustomSkillDrawerProps {
  state: DrawerState;
  onChange: (next: DrawerState) => void;
  onClose: () => void;
  onSave: (state: DrawerState) => Promise<SaveResult>;
  saving: boolean;
}

export function CustomSkillDrawer({
  state,
  onChange,
  onClose,
  onSave,
  saving,
}: CustomSkillDrawerProps) {
  const [chatOpen, setChatOpen] = useState(true);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [pendingUpdates, setPendingUpdates] = useState<FieldUpdate[]>([]);
  const [composerText, setComposerText] = useState('');
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [keywordDraft, setKeywordDraft] = useState('');

  const isEdit = Boolean(state.id);
  const drawerWidth = chatOpen ? 'w-[1180px]' : 'w-[680px]';

  function patch(p: Partial<DrawerState>) {
    onChange({ ...state, ...p });
  }

  async function sendChat() {
    if (!composerText.trim()) return;
    if (refining) return;
    const userMsg = composerText.trim();
    const newHistory: ChatTurn[] = [...chat, { role: 'user', content: userMsg }];
    setChat(newHistory);
    setComposerText('');
    setPendingUpdates([]); // each round of suggestions is ephemeral
    setRefining(true);
    setRefineError(null);
    try {
      const r = await api<RefineResponse>('/api/admin/custom-skills/refine', {
        method: 'POST',
        body: JSON.stringify({
          draft: {
            name: state.name,
            display_name: state.display_name,
            description: state.description,
            body_md: state.body,
            routing_keywords: state.routing_keywords,
          },
          history: chat,
          user_message: userMsg,
        }),
      });
      const replyText = r.reply_text || (r.updates.length > 0 ? '(Proposed changes below.)' : '');
      setChat([...newHistory, { role: 'assistant', content: replyText }]);
      setPendingUpdates(r.updates);
    } catch (e) {
      setRefineError(humanizeRefineError(e));
    } finally {
      setRefining(false);
    }
  }

  function applyUpdate(u: FieldUpdate) {
    if (u.field === 'display_name' && u.kind === 'replace') {
      patch({ display_name: u.value });
    } else if (u.field === 'description' && u.kind === 'replace') {
      patch({ description: u.value });
    } else if (u.field === 'body_md' && u.kind === 'replace') {
      patch({ body: u.value });
    } else if (u.field === 'body_md' && u.kind === 'append') {
      patch({ body: state.body.trimEnd() + '\n\n' + u.value });
    } else if (u.field === 'routing_keywords' && u.kind === 'replace') {
      patch({ routing_keywords: dedupeKw(u.value) });
    } else if (u.field === 'routing_keywords' && u.kind === 'append') {
      patch({ routing_keywords: dedupeKw([...state.routing_keywords, ...u.value]) });
    }
    setPendingUpdates((cur) => cur.filter((x) => x !== u));
  }

  function discardUpdate(u: FieldUpdate) {
    setPendingUpdates((cur) => cur.filter((x) => x !== u));
  }

  function addKeyword() {
    const v = keywordDraft.trim().toLowerCase();
    if (!v) return;
    if (state.routing_keywords.includes(v)) {
      setKeywordDraft('');
      return;
    }
    patch({ routing_keywords: [...state.routing_keywords, v].slice(0, 50) });
    setKeywordDraft('');
  }
  function removeKeyword(k: string) {
    patch({ routing_keywords: state.routing_keywords.filter((x) => x !== k) });
  }

  return (
    <div className="fixed inset-0 bg-ink/40 z-30">
      <div
        className={`absolute right-0 top-0 bottom-0 ${drawerWidth} bg-paper p-6 overflow-y-auto shadow-2xl flex flex-col`}
      >
        <header className="flex items-baseline justify-between mb-4 shrink-0">
          <h2 className="font-display text-xl">
            {isEdit ? `Edit ${state.name}` : 'New custom skill'}
          </h2>
          <div className="flex items-center gap-3 text-sm">
            <button
              onClick={() => setChatOpen((v) => !v)}
              className="text-ink/60 hover:text-ink underline-offset-2 hover:underline"
              title={chatOpen ? 'Hide chat panel' : 'Show chat with Claude'}
            >
              {chatOpen ? 'Hide chat' : 'Chat with Claude'}
            </button>
            <button onClick={onClose} className="text-ink/50 hover:text-ink">
              Close
            </button>
          </div>
        </header>

        <div
          className="flex-1 grid gap-6 min-h-0"
          style={{ gridTemplateColumns: chatOpen ? '1fr 1fr' : '1fr' }}
        >
          {/* ── Fields pane ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
            {state.source && (
              <div className="border border-gold/40 bg-gold/5 rounded p-3 text-xs flex items-baseline justify-between gap-3">
                <div>
                  <div className="font-display text-sm text-ink mb-0.5">
                    Drafted from <span className="font-mono">{state.source.filename}</span>
                  </div>
                  <label className="flex items-center gap-2 text-ink/70 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={state.include_source_as_reference}
                      onChange={(e) => patch({ include_source_as_reference: e.target.checked })}
                    />
                    <span>
                      Attach the parsed source as a reference file so Claude can quote it at
                      runtime.
                    </span>
                  </label>
                </div>
              </div>
            )}

            <input
              placeholder="slug (lowercase, hyphens; e.g. firm-billing-rates)"
              value={state.name}
              onChange={(e) => patch({ name: e.target.value })}
              disabled={isEdit}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm disabled:bg-ink/5 disabled:text-ink/50"
              title={isEdit ? 'Slug is fixed once published' : undefined}
            />
            <input
              placeholder="display name"
              value={state.display_name}
              onChange={(e) => patch({ display_name: e.target.value })}
              className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
            />
            <textarea
              placeholder="description (≤1024 chars, plain text — no HTML/XML)"
              value={state.description}
              onChange={(e) => patch({ description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-ink/20 rounded text-sm resize-none"
            />

            <div>
              <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">
                Routing keywords{' '}
                <span className="text-ink/40 normal-case tracking-normal">
                  ({state.routing_keywords.length}/50 — phrases that should fire this skill)
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {state.routing_keywords.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 bg-ink/5 border border-ink/10 rounded px-1.5 py-0.5 text-xs"
                  >
                    <span className="font-mono">{k}</span>
                    <button
                      type="button"
                      onClick={() => removeKeyword(k)}
                      className="text-ink/40 hover:text-oxblood"
                      aria-label={`Remove ${k}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                placeholder="add a keyword and press Enter"
                value={keywordDraft}
                onChange={(e) => setKeywordDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    addKeyword();
                  }
                }}
                onBlur={addKeyword}
                className="w-full px-3 py-1.5 border border-ink/20 rounded text-xs font-mono"
              />
            </div>

            <div>
              <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">SKILL.md body</div>
              <div className="border border-ink/20 rounded overflow-hidden">
                <Editor
                  height="380px"
                  defaultLanguage="markdown"
                  value={state.body}
                  onChange={(v) => patch({ body: v ?? '' })}
                />
              </div>
            </div>

            {isEdit && (
              <p className="text-xs text-ink/50">
                Saving stores the draft in the appliance database. Click{' '}
                <span className="font-mono">republish</span> on the row afterwards to push the new
                content to Anthropic.
              </p>
            )}
          </div>

          {/* ── Chat pane ─────────────────────────────────────────────────── */}
          {chatOpen && (
            <div className="flex flex-col min-h-0 border-l border-ink/10 pl-6">
              <div className="text-xs uppercase tracking-wider text-ink/50 mb-2">
                Chat with Claude about this skill
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                {chat.length === 0 && pendingUpdates.length === 0 && (
                  <p className="text-sm text-ink/50 italic">
                    Ask Claude to refine this skill — broaden routing, add a section, tighten the
                    description, etc. Suggestions land as Apply / Discard cards before they touch
                    your draft.
                  </p>
                )}
                {chat.map((m, i) => (
                  <div key={i} className="mb-3">
                    <div className="text-[10px] uppercase tracking-wider text-ink/50 mb-0.5">
                      {m.role === 'user' ? 'You' : 'Claude'}
                    </div>
                    <div
                      className={`text-sm whitespace-pre-wrap ${
                        m.role === 'user' ? 'bg-ink/5 rounded p-2' : 'text-ink/80'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {refining && <div className="text-xs text-ink/50 italic">Claude is thinking…</div>}
                {pendingUpdates.length > 0 && (
                  <div className="mt-3 mb-2">
                    <div className="text-[10px] uppercase tracking-wider text-ink/50 mb-1.5">
                      Proposed changes ({pendingUpdates.length})
                    </div>
                    <div className="space-y-2">
                      {pendingUpdates.map((u, i) => (
                        <UpdateCard
                          key={i}
                          update={u}
                          onApply={() => applyUpdate(u)}
                          onDiscard={() => discardUpdate(u)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {refineError && (
                  <div className="text-oxblood text-sm border border-oxblood/40 bg-oxblood/5 rounded p-2 mt-2">
                    {refineError}
                  </div>
                )}
              </div>
              <div className="shrink-0 mt-3">
                <textarea
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder="e.g. Add a section about §199A SSTBs, or broaden routing keywords."
                  rows={3}
                  disabled={refining}
                  className="w-full px-3 py-2 border border-ink/20 rounded text-sm resize-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void sendChat();
                    }
                  }}
                />
                <div className="flex justify-between items-center mt-1.5">
                  <span className="text-[10px] text-ink/40">⌘/Ctrl + Enter to send</span>
                  <button
                    onClick={() => void sendChat()}
                    disabled={refining || !composerText.trim()}
                    className="px-3 py-1.5 bg-ink text-paper rounded text-xs disabled:opacity-50"
                  >
                    {refining ? 'Asking…' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 flex justify-end gap-2 mt-4 pt-4 border-t border-ink/10">
          <button onClick={onClose} className="px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            onClick={() => void onSave(state)}
            disabled={
              saving ||
              state.name.length < 3 ||
              state.display_name.length < 1 ||
              state.description.length < 1 ||
              state.body.length < 1
            }
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save draft'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function dedupeKw(arr: string[]): string[] {
  return Array.from(
    new Set(arr.map((k) => k.toLowerCase().trim()).filter((k) => k.length > 0 && k.length <= 64)),
  ).slice(0, 50);
}

function UpdateCard({
  update,
  onApply,
  onDiscard,
}: {
  update: FieldUpdate;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const label = describeUpdate(update);
  return (
    <div className="border border-gold/40 bg-gold/5 rounded p-2 text-xs">
      <div className="font-display text-sm text-ink mb-1">{label}</div>
      {(update.field === 'body_md' || update.field === 'description') && (
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-ink/70 max-h-32 overflow-auto">
          {update.value as string}
        </pre>
      )}
      {update.field === 'routing_keywords' && Array.isArray(update.value) && (
        <div className="flex flex-wrap gap-1">
          {(update.value as string[]).map((k) => (
            <span key={k} className="bg-ink/5 px-1.5 py-0.5 rounded font-mono text-[10px]">
              {k}
            </span>
          ))}
        </div>
      )}
      {update.field === 'display_name' && (
        <div className="font-mono text-[11px] text-ink/70">{update.value as string}</div>
      )}
      <div className="mt-1.5 flex gap-2">
        <button onClick={onApply} className="px-2 py-0.5 bg-ink text-paper rounded text-[11px]">
          Apply
        </button>
        <button onClick={onDiscard} className="px-2 py-0.5 text-[11px] text-ink/60 hover:text-ink">
          Discard
        </button>
      </div>
    </div>
  );
}

function describeUpdate(u: FieldUpdate): string {
  if (u.field === 'display_name') return 'Set display name';
  if (u.field === 'description') return 'Replace description';
  if (u.field === 'body_md' && u.kind === 'replace') return 'Replace body_md';
  if (u.field === 'body_md' && u.kind === 'append') return 'Append to body_md';
  if (u.field === 'routing_keywords' && u.kind === 'replace') return 'Replace routing keywords';
  if (u.field === 'routing_keywords' && u.kind === 'append') return 'Add routing keywords';
  return 'Update';
}

function humanizeRefineError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === 'anthropic_key_missing')
      return 'Save your Anthropic API key under Admin → Settings before chatting with Claude.';
    if (e.message === 'refine_failed')
      return 'Claude returned an error. Try again or simplify the prompt.';
    return e.message;
  }
  return (e as Error).message;
}
