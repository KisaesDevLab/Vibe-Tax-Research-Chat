// Admin → Client errors: render failures reported by the SPA's error
// boundaries (see lib/client-errors.ts). One row per distinct failure; the
// count climbs each time someone hits it again. Rows unseen for 90 days are
// pruned automatically.
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface ClientErrorRow {
  id: string;
  kind: 'panel' | 'app' | 'window';
  source: string | null;
  message: string;
  stack: string | null;
  component_stack: string | null;
  route: string | null;
  chat_id: string | null;
  message_id: string | null;
  app_version: string | null;
  user_agent: string | null;
  user_email: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

function whereLabel(e: ClientErrorRow): string {
  if (e.kind === 'panel') return `${e.source ?? 'Unknown'} panel`;
  if (e.kind === 'app') return 'Whole page';
  return 'Script';
}

export function AdminClientErrorsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery<{ errors: ClientErrorRow[] }>({
    queryKey: ['admin', 'client-errors'],
    queryFn: () => api('/api/admin/client-errors'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/admin/client-errors/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'client-errors'] }),
  });
  const clear = useMutation({
    mutationFn: () => api('/api/admin/client-errors', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'client-errors'] }),
  });
  const rows = data?.errors ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-3xl">Client errors</h1>
        {rows.length > 0 && (
          <button
            type="button"
            className="px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5 disabled:opacity-50"
            disabled={clear.isPending}
            onClick={() => {
              if (window.confirm('Clear every client error? This cannot be undone.'))
                clear.mutate();
            }}
          >
            Clear all
          </button>
        )}
      </div>

      <p className="text-xs text-ink/60 mb-4 max-w-3xl">
        Parts of the app that failed to display in someone&apos;s browser. A failed panel is
        replaced by a short notice and the rest of the answer still shows; a whole-page failure
        shows a recovery page. Each row is one distinct failure, counted each time it recurs. Only
        the error and where it happened are recorded — never chat or document content.
      </p>

      {isLoading && <p className="text-sm text-ink/60">Loading…</p>}
      {error && <p className="text-sm text-oxblood">Could not load client errors.</p>}
      {!isLoading && !error && rows.length === 0 && (
        <p className="text-sm text-ink/60">No client errors reported.</p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
                <th className="py-2 pr-3">Last seen</th>
                <th className="pr-3">Count</th>
                <th className="pr-3">Where</th>
                <th className="pr-3">Error</th>
                <th className="pr-3">Chat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr className="border-b border-ink/5 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {new Date(e.last_seen_at).toLocaleString()}
                    </td>
                    <td className="pr-3 py-2 font-mono">{e.count}</td>
                    <td className="pr-3 py-2 whitespace-nowrap">{whereLabel(e)}</td>
                    <td className="pr-3 py-2 font-mono text-xs break-words max-w-md">
                      {e.message}
                    </td>
                    <td className="pr-3 py-2 whitespace-nowrap">
                      {e.chat_id ? (
                        <Link
                          to={`/research/${e.chat_id}`}
                          className="underline text-xs font-mono"
                          title={e.chat_id}
                        >
                          {e.chat_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <span className="text-ink/40">—</span>
                      )}
                    </td>
                    <td className="py-2 whitespace-nowrap text-right">
                      <button
                        type="button"
                        className="text-xs underline text-ink/60 hover:text-ink mr-3"
                        onClick={() => setOpen(open === e.id ? null : e.id)}
                      >
                        {open === e.id ? 'Hide' : 'Details'}
                      </button>
                      <button
                        type="button"
                        className="text-xs underline text-ink/60 hover:text-oxblood disabled:opacity-50"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(e.id)}
                      >
                        Dismiss
                      </button>
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr className="border-b border-ink/5">
                      <td colSpan={6} className="pb-3">
                        <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
                          <dt className="text-ink/50">First seen</dt>
                          <dd>{new Date(e.first_seen_at).toLocaleString()}</dd>
                          <dt className="text-ink/50">Last user</dt>
                          <dd>{e.user_email ?? '—'}</dd>
                          <dt className="text-ink/50">Route</dt>
                          <dd className="font-mono break-all">{e.route ?? '—'}</dd>
                          <dt className="text-ink/50">Message id</dt>
                          <dd className="font-mono break-all">{e.message_id ?? '—'}</dd>
                          <dt className="text-ink/50">App version</dt>
                          <dd className="font-mono">{e.app_version ?? '—'}</dd>
                          <dt className="text-ink/50">Browser</dt>
                          <dd className="break-words">{e.user_agent ?? '—'}</dd>
                        </dl>
                        {e.stack && (
                          <pre className="mt-2 p-2 bg-ink/5 rounded text-[11px] overflow-x-auto whitespace-pre">
                            {e.stack}
                          </pre>
                        )}
                        {e.component_stack && (
                          <pre className="mt-2 p-2 bg-ink/5 rounded text-[11px] overflow-x-auto whitespace-pre">
                            {e.component_stack.trim()}
                          </pre>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
