// TP-11 — research tab: the client's archived sessions with per-client
// full-text search (post-redaction snapshot text, title, tags).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ArchiveListItemDTO, ClientDTO } from '@vibe/shared';
import { api } from '../../../lib/api';

export function ResearchTab({ client }: { client: ClientDTO; counts?: { chats: number } }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isLoading } = useQuery<{ archives: ArchiveListItemDTO[] }>({
    queryKey: ['archives', client.id, { q: debounced }],
    queryFn: () => api(`/api/archives?client_id=${client.id}&q=${encodeURIComponent(debounced)}`),
  });

  const rows = data?.archives ?? [];

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search this client's archived research…"
        className="w-full md:w-96 px-3 py-2 border border-ink/20 rounded text-sm mb-4"
      />
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          {debounced
            ? 'No archives match your search.'
            : 'No archived research yet. Use “Archive…” on a research session to file it here.'}
        </div>
      ) : (
        <ul className="divide-y divide-ink/5">
          {rows.map((a) => (
            <li key={a.id} className="py-3">
              <Link
                to={`/clients/${client.id}/research/${a.id}`}
                className="font-medium hover:underline"
              >
                {a.title}
              </Link>
              {a.status === 'superseded' && (
                <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-ink/10 rounded">
                  superseded
                </span>
              )}
              <div className="text-xs text-ink/50 mt-0.5 flex flex-wrap gap-x-3">
                <span>{new Date(a.archived_at).toLocaleDateString()}</span>
                <span>{a.message_count} messages</span>
                {a.topic_tags.length > 0 && <span>{a.topic_tags.join(' · ')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
