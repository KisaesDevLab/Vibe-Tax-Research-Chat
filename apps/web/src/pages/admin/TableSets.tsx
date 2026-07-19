// TP-4 — read-only table-set viewer. The write path is the TP-14
// tables:draft → review → publish flow; admins only inspect here.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TableSetDTO } from '@vibe/shared';
import { api } from '../../lib/api';

interface TableSetListRow {
  id: string;
  tax_year: number;
  version: number;
  status: 'draft' | 'published';
  published_at: string | null;
  created_at: string;
}

export function AdminTableSetsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useQuery<{ table_sets: TableSetListRow[] }>({
    queryKey: ['admin', 'table-sets'],
    queryFn: () => api('/api/admin/table-sets'),
  });

  const rows = data?.table_sets ?? [];

  return (
    <div>
      <h1 className="font-display text-3xl mb-2">Table sets</h1>
      <p className="text-sm text-ink/60 mb-6 max-w-2xl">
        Versioned tax constants the planning engine computes from. Plans pin a table set at compute
        time; publishing a new set never changes an issued plan.
      </p>
      {isLoading ? (
        <div className="text-ink/50">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
          No table sets. Enable the planning module and re-run the seed.
        </div>
      ) : (
        <table className="w-full max-w-2xl text-sm border-collapse mb-6">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
              <th className="py-2 pr-4">Tax year</th>
              <th className="py-2 pr-4">Version</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2">Published</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => setSelectedId(r.id === selectedId ? null : r.id)}
                className={`border-b border-ink/5 cursor-pointer hover:bg-ink/5 ${
                  selectedId === r.id ? 'bg-ink/10' : ''
                }`}
              >
                <td className="py-2 pr-4 font-mono">{r.tax_year}</td>
                <td className="py-2 pr-4 font-mono">v{r.version}</td>
                <td className="py-2 pr-4">
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      r.status === 'published' ? 'bg-moss/15 text-moss' : 'bg-gold/15 text-ink/60'
                    }`}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="py-2 text-ink/60">
                  {r.published_at ? new Date(r.published_at).toLocaleDateString() : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selectedId && <TableSetDetail id={selectedId} />}
    </div>
  );
}

function TableSetDetail({ id }: { id: string }) {
  const { data, isLoading } = useQuery<{ table_set: TableSetDTO }>({
    queryKey: ['admin', 'table-set', id],
    queryFn: () => api(`/api/admin/table-sets/${id}`),
  });
  if (isLoading) return <div className="text-ink/50">Loading payload…</div>;
  const ts = data?.table_set;
  if (!ts) return null;
  return (
    <div className="max-w-3xl space-y-4">
      {Object.entries(ts.payload).map(([group, value]) => (
        <section key={group} className="border border-ink/10 rounded p-4 bg-white">
          <h2 className="font-display text-lg mb-2">{group}</h2>
          <pre className="text-xs font-mono overflow-x-auto bg-ink/5 rounded p-3">
            {JSON.stringify(value, null, 2)}
          </pre>
        </section>
      ))}
      <section className="border border-ink/10 rounded p-4 bg-white">
        <h2 className="font-display text-lg mb-2">Source notes</h2>
        <ul className="text-sm space-y-2">
          {ts.source_notes.map((n, i) => (
            <li key={i}>
              <span className="font-medium">{n.group}</span>
              <span className="text-ink/60"> — {n.authority}</span>
              {n.url && (
                <a
                  href={n.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-2 underline text-oxblood text-xs"
                >
                  source
                </a>
              )}
              {n.note && <div className="text-xs text-ink/50 mt-0.5">{n.note}</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
