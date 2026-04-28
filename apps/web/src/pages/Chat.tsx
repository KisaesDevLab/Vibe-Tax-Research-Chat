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
import { useChatStream } from '../hooks/useChatStream';
import { api } from '../lib/api';
import type { ChatDTO, MessageDTO } from '@vibe/shared';

export function ChatPage() {
  const { chatId } = useParams<{ chatId?: string }>();
  if (!chatId) {
    return (
      <div className="grid grid-cols-[260px_1fr] min-h-screen">
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
    <div className="grid grid-cols-[260px_1fr] min-h-screen bg-paper">
      <ChatSidebar />
      <div className="flex flex-col">
        <header className="px-8 py-4 border-b border-ink/10 flex items-center justify-between">
          <div className="font-display text-lg">{data?.chat.title ?? 'Loading…'}</div>
          <div className="font-mono text-xs text-ink/50">
            {data?.messages.length ?? 0} messages
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-8 py-6 max-w-4xl mx-auto w-full">
          {data?.messages.map((m) => (
            <MessageBlock key={m.id} message={m} />
          ))}
          {streaming && (
            <div className="mt-6">
              <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Assistant (streaming)</div>
              <Markdown>{streaming.text || '…'}</Markdown>
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
          )}
        </main>

        <form onSubmit={onSubmit} className="px-8 py-4 border-t border-ink/10 max-w-4xl mx-auto w-full">
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
              <button type="button" onClick={abort} className="px-4 py-2 border border-oxblood text-oxblood rounded">
                Stop
              </button>
            ) : (
              <button type="submit" className="px-4 py-2 bg-ink text-paper rounded">
                Send
              </button>
            )}
          </div>
          <div className="text-[10px] text-ink/40 mt-1">⌘/Ctrl + Enter to send</div>
        </form>
      </div>
    </div>
  );
}

function MessageBlock({ message: m }: { message: MessageDTO }) {
  if (m.role === 'user') {
    return (
      <div className="mb-6">
        <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">You</div>
        <div className="bg-ink/5 rounded p-3 font-body">{m.content}</div>
      </div>
    );
  }
  if (m.role === 'system_note') {
    return <div className="my-4 text-xs text-ink/50 italic">{m.content}</div>;
  }
  return (
    <div className="mb-8">
      <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Assistant</div>
      <Markdown>{m.content}</Markdown>
      <AuthoritiesPanel authorities={(m.authorities as never) ?? []} />
      <CompliancePanel check={m.compliance_check} />
      <SkillsPanel skills={m.skills} />
      <CostLedger
        usage={m.usage}
        cost_usd={m.cost_usd}
        model_id={m.model_id}
      />
    </div>
  );
}
