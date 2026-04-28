// Phase 14 — SSE consumer for streaming chat. Reconnect, abort, partial render.
import { useCallback, useRef, useState } from 'react';
import { apiUrl } from '../lib/api';
import { tokenStore } from '../lib/token-store';

export interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  web_fetch_calls?: number;
  web_search_calls?: number;
}

export interface StreamingMessage {
  text: string;
  usage: StreamUsage;
  tool_uses: Array<{ id: string; tool_name: string; input: unknown; status?: string }>;
  done: boolean;
  cost?: number;
  error?: string;
  // What the user just sent. Held in the streaming object so the chat
  // view can show the question immediately instead of waiting for the
  // refetch that happens after `done` to surface it via the messages
  // GET response.
  user_message: string;
  // ms epoch when the request was kicked off, for an "elapsed" timer.
  started_at: number;
}

export function useChatStream() {
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(async (chatId: string, content: string, model_id?: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming({
      text: '',
      usage: {},
      tool_uses: [],
      done: false,
      user_message: content,
      started_at: Date.now(),
    });

    const access = tokenStore.getAccess();
    const res = await fetch(apiUrl(`/api/chats/${chatId}/messages`), {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        ...(access ? { authorization: `Bearer ${access}` } : {}),
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ content, model_id }),
    });
    if (!res.ok || !res.body) {
      setStreaming((s) => ({
        ...(s ?? {
          text: '',
          usage: {},
          tool_uses: [],
          done: true,
          user_message: content,
          started_at: Date.now(),
        }),
        done: true,
        error: `HTTP ${res.status}`,
      }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSse(chunk);
        if (!event) continue;
        setStreaming((cur) => {
          const c = cur ?? {
            text: '',
            usage: {},
            tool_uses: [],
            done: false,
            user_message: '',
            started_at: Date.now(),
          };
          switch (event.event) {
            case 'text':
              return { ...c, text: c.text + (event.data as { delta: string }).delta };
            case 'tool_use':
              return {
                ...c,
                tool_uses: [
                  ...c.tool_uses,
                  event.data as { id: string; tool_name: string; input: unknown },
                ],
              };
            case 'tool_result': {
              const r = event.data as { id: string; status: string };
              return {
                ...c,
                tool_uses: c.tool_uses.map((t) => (t.id === r.id ? { ...t, status: r.status } : t)),
              };
            }
            case 'usage':
              return { ...c, usage: { ...c.usage, ...(event.data as StreamUsage) } };
            case 'done': {
              const d = event.data as { cost: number; usage: StreamUsage };
              return { ...c, done: true, cost: d.cost, usage: { ...c.usage, ...d.usage } };
            }
            case 'error':
              return { ...c, done: true, error: (event.data as { error: string }).error };
            default:
              return c;
          }
        });
      }
    }
    abortRef.current = null;
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming((s) => (s ? { ...s, done: true } : null));
  }, []);

  return { streaming, send, abort, reset: () => setStreaming(null) };
}

function parseSse(chunk: string): { event: string; data: unknown } | null {
  const lines = chunk.split('\n');
  let event = 'message';
  let data = '';
  for (const ln of lines) {
    if (ln.startsWith('event: ')) event = ln.slice(7).trim();
    else if (ln.startsWith('data: ')) data += ln.slice(6);
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}
