// Phase 14-20 — chat page. Composes sidebar + message list + composer + panels.
import { useState, type FormEvent, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChatSidebar } from '../components/ChatSidebar';
import { Markdown } from '../components/Markdown';
import { CostLedger } from '../components/CostLedger';
import { AuthoritiesPanel } from '../components/panels/AuthoritiesPanel';
import { CompliancePanel } from '../components/panels/CompliancePanel';
import { SkillsPanel } from '../components/panels/SkillsPanel';
import { useChatStream, type StreamingMessage } from '../hooks/useChatStream';
import { api } from '../lib/api';
import type { ChatDTO, MessageDTO } from '@vibe/shared';

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
  if (!chatId) {
    return (
      <div className="grid grid-cols-[260px_1fr] h-screen overflow-hidden">
        <ChatSidebar />
        <div className="grid place-items-center text-ink/50">
          <div className="text-center">
            <div className="font-display text-2xl mb-2">Start a new research thread</div>
            <div className="text-sm">Select &quot;+ New&quot; in the sidebar.</div>
          </div>
        </div>
      </div>
    );
  }
  return <ChatView chatId={chatId} />;
}

function ChatView({ chatId }: { chatId: string }) {
  const [draft, setDraft] = useState('');
  const { streaming, send, abort, reset } = useChatStream();

  const { data, refetch } = useQuery<{ chat: ChatDTO; messages: MessageDTO[] }>({
    queryKey: ['chat', chatId],
    queryFn: () => api(`/api/chats/${chatId}`),
  });

  useEffect(() => {
    if (streaming?.done) {
      void refetch();
      reset();
    }
  }, [streaming?.done, refetch, reset]);

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
    // h-screen + overflow-hidden on the outer grid so the sidebar and chat
    // column are each capped at the viewport. The chat column is a flex
    // column with min-h-0 (the magic that lets a flex child actually scroll
    // instead of forcing the parent taller), header and form are
    // shrink-to-content, and only <main> scrolls between them.
    <div className="grid grid-cols-[260px_1fr] h-screen overflow-hidden bg-paper">
      <ChatSidebar />
      <div className="flex flex-col min-h-0">
        <header className="shrink-0 px-7 py-4 border-b border-ink/10 flex items-center justify-between">
          <div className="font-display text-lg">{data?.chat.title ?? 'Loading…'}</div>
          <div className="font-mono text-xs text-ink/50">{data?.messages.length ?? 0} messages</div>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-7 py-6 max-w-4xl w-full">
            {data?.messages.map((m) => (
              <MessageBlock key={m.id} message={m} />
            ))}
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
                </div>
              </>
            )}
          </div>
        </main>

        <form onSubmit={onSubmit} className="shrink-0 px-7 py-4 border-t border-ink/10 bg-paper">
          <div className="max-w-4xl w-full">
            <div className="flex gap-2">
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
            <div className="text-[10px] text-ink/40 mt-1">⌘/Ctrl + Enter to send</div>
          </div>
        </form>
      </div>
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

function MessageBlock({ message: m }: { message: MessageDTO }) {
  if (m.role === 'user') {
    return (
      <div className="mb-4">
        <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
        <div className="bg-ink/5 rounded p-3 font-body">{m.content}</div>
      </div>
    );
  }
  if (m.role === 'system_note') {
    return <div className="my-3 text-xs text-ink/50 italic">{m.content}</div>;
  }
  return (
    // Wrap the assistant body + panels in a vertical-rhythm container so
    // every block (Markdown prose, Authorities, Compliance, Skills, Cost)
    // gets the same 12px gap. Reduces the previous mish-mash of mt-4 +
    // implicit margin into a single uniform stack.
    <div className="mb-6 space-y-3">
      <div className="text-xs uppercase tracking-wider text-ink/50">Assistant</div>
      <Markdown>{stripSidecars(m.content)}</Markdown>
      <AuthoritiesPanel authorities={(m.authorities as never) ?? []} />
      <CompliancePanel check={m.compliance_check} />
      <SkillsPanel skills={m.skills} />
      <CostLedger usage={m.usage} cost_usd={m.cost_usd} model_id={m.model_id} />
    </div>
  );
}
