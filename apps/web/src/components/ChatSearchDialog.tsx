// Chat history search — a command-palette style overlay (⌘/Ctrl+K or the
// magnifier in the sidebar). Searches titles and message content through
// GET /api/chats/search, shows one row per chat with the matching excerpt,
// and navigates on Enter / click. Query is debounced so typing doesn't fire
// a request per keystroke; arrow keys move the selection.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ChatSearchResult } from '@vibe/shared';
import { api } from '../lib/api';

const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Wrap every case-insensitive occurrence of `q` in <mark>. Plain string
// split — no regex construction from user input.
function Highlight({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: Array<{ s: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(needle, i);
    if (j < 0) {
      parts.push({ s: text.slice(i), hit: false });
      break;
    }
    if (j > i) parts.push({ s: text.slice(i, j), hit: false });
    parts.push({ s: text.slice(j, j + needle.length), hit: true });
    i = j + needle.length;
  }
  return (
    <>
      {parts.map((p, k) =>
        p.hit ? (
          <mark key={k} className="bg-gold/30 text-ink rounded-sm px-0.5">
            {p.s}
          </mark>
        ) : (
          <span key={k}>{p.s}</span>
        ),
      )}
    </>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function ChatSearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounced = useDebounced(q.trim(), DEBOUNCE_MS);
  const enabled = debounced.length >= MIN_QUERY;

  const { data, isFetching, isError } = useQuery<{ results: ChatSearchResult[]; q: string }>({
    queryKey: ['chat-search', debounced],
    queryFn: () => api(`/api/chats/search?q=${encodeURIComponent(debounced)}&limit=30`),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const results = useMemo(() => (enabled ? (data?.results ?? []) : []), [data, enabled]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setCursor(0);
  }, [debounced]);
  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  function open(r: ChatSearchResult) {
    onClose();
    navigate(`/research/${r.chat.id}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      const r = results[cursor];
      if (r) {
        e.preventDefault();
        open(r);
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 flex items-start justify-center p-4 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal
      aria-label="Search chat history"
    >
      <div
        className="bg-paper rounded shadow-xl w-full max-w-2xl flex flex-col max-h-[70vh] overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-ink/10">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-ink/50 shrink-0"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your chats — titles and messages…"
            className="flex-1 bg-transparent outline-none font-body text-base"
            aria-label="Search query"
            autoComplete="off"
            spellCheck={false}
          />
          {isFetching && (
            <span className="text-[10px] uppercase tracking-wider text-ink/40">…</span>
          )}
          <kbd className="hidden sm:inline text-[10px] text-ink/40 border border-ink/15 rounded px-1">
            esc
          </kbd>
        </div>

        <div className="overflow-y-auto min-h-0">
          {!enabled ? (
            <div className="px-4 py-6 text-sm text-ink/50">
              Type at least {MIN_QUERY} characters. Matches chat titles and the text of every turn —
              cites like <span className="font-mono">199A</span> work.
            </div>
          ) : isError ? (
            <div className="px-4 py-6 text-sm text-oxblood">Search failed. Try again.</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink/50">
              {isFetching ? 'Searching…' : `No chats mention “${debounced}”.`}
            </div>
          ) : (
            <ul ref={listRef} role="listbox" aria-label="Search results">
              {results.map((r, i) => (
                <li
                  key={r.chat.id}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => open(r)}
                  className={`px-4 py-2.5 cursor-pointer border-b border-ink/5 last:border-b-0 ${
                    i === cursor ? 'bg-ink/5' : ''
                  }`}
                >
                  <div className="flex items-baseline gap-2 min-w-0">
                    {r.chat.client_id && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full bg-moss shrink-0"
                        title="Linked to a client"
                      />
                    )}
                    <span className="font-display truncate">
                      <Highlight text={r.chat.title} q={debounced} />
                    </span>
                    {r.chat.archived_at && (
                      <span className="text-[10px] uppercase tracking-wider text-ink/40 shrink-0">
                        archived
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-ink/40 shrink-0">
                      {when(r.chat.updated_at)}
                    </span>
                  </div>
                  {r.message && (
                    <div className="mt-0.5 text-xs text-ink/60 leading-relaxed line-clamp-2">
                      <span className="uppercase tracking-wider text-[10px] text-ink/40 mr-1.5">
                        {r.message.role === 'user' ? 'You' : 'Assistant'}
                      </span>
                      <Highlight text={r.message.snippet} q={debounced} />
                      {r.match_count > 1 && (
                        <span className="text-ink/40"> · {r.match_count} matching turns</span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-4 py-2 border-t border-ink/10 text-[10px] text-ink/40 flex gap-4">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
