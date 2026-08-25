// TP-3a — version history with a structural diff against current and
// restore-as-new-version. Ordered by created_at (a client merge can leave
// duplicate version numbers across lineages).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientFactPatternDTO, FactPatternVersionSummaryDTO } from '@vibe/shared';
import { api } from '../../../lib/api';

interface DiffRow {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: string;
  to?: string;
}

function flatten(value: unknown, prefix: string, out: Map<string, string>) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'sources') continue; // provenance churn isn't a fact change
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.set(prefix, String(value));
}

export function diffFacts(from: unknown, to: unknown): DiffRow[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(from, '', a);
  flatten(to, '', b);
  const rows: DiffRow[] = [];
  for (const [path, v] of b) {
    if (!a.has(path)) rows.push({ path, kind: 'added', to: v });
    else if (a.get(path) !== v) rows.push({ path, kind: 'changed', from: a.get(path), to: v });
  }
  for (const [path, v] of a) {
    if (!b.has(path)) rows.push({ path, kind: 'removed', from: v });
  }
  return rows.sort((x, y) => x.path.localeCompare(y.path));
}

export function FactsVersionHistory({
  clientId,
  current,
}: {
  clientId: string;
  current: ClientFactPatternDTO;
}) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<{ versions: FactPatternVersionSummaryDTO[] }>({
    queryKey: ['client-fact-versions', clientId],
    queryFn: () => api(`/api/clients/${clientId}/facts/versions`),
  });

  const { data: selected } = useQuery<{ fact_pattern: ClientFactPatternDTO }>({
    queryKey: ['client-fact-version', clientId, selectedId],
    queryFn: () => api(`/api/clients/${clientId}/facts/versions/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api(`/api/clients/${clientId}/facts/restore`, {
        method: 'POST',
        body: JSON.stringify({ version_id: versionId }),
      }),
    onSuccess: () => {
      setError(null);
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ['client-facts', clientId] });
      void qc.invalidateQueries({ queryKey: ['client-fact-versions', clientId] });
    },
    onError: () => setError('Restore failed — reload and try again.'),
  });

  const versions = data?.versions ?? [];
  const diff =
    selected && selectedId !== current.id
      ? diffFacts(selected.fact_pattern.facts, current.facts)
      : [];

  return (
    <div className="border border-ink/10 rounded p-4 bg-white">
      <h3 className="font-display text-lg mb-2">Version history</h3>
      {error && <div className="text-oxblood text-sm mb-2">{error}</div>}
      <ul className="space-y-1 text-sm">
        {versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2">
            <button
              onClick={() => setSelectedId(v.id === selectedId ? null : v.id)}
              className={`underline-offset-2 ${v.id === selectedId ? 'font-medium underline' : 'hover:underline'}`}
            >
              v{v.version}
            </button>
            <span className="text-ink/60 truncate">{v.change_summary}</span>
            <span className="text-ink/40 text-xs shrink-0">
              {new Date(v.created_at).toLocaleDateString()}
            </span>
            {v.superseded_at === null && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-moss/15 text-moss shrink-0">
                current
              </span>
            )}
          </li>
        ))}
      </ul>

      {selected && selectedId && selectedId !== current.id && (
        <div className="mt-3 border-t border-ink/10 pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-ink/60">
              Diff: v{selected.fact_pattern.version} → current v{current.version}
            </div>
            <button
              onClick={() => restore.mutate(selectedId)}
              disabled={restore.isPending}
              className="px-2 py-1 border border-ink/20 rounded text-xs hover:bg-ink/5 disabled:opacity-50"
            >
              Restore as new version
            </button>
          </div>
          {diff.length === 0 ? (
            <div className="text-ink/40 text-sm">No fact-level differences.</div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <tbody>
                {diff.map((row) => (
                  <tr key={`${row.kind}:${row.path}`} className="border-b border-ink/5 align-top">
                    <td className="py-1 pr-2 font-mono">{row.path}</td>
                    <td className="py-1 pr-2">
                      {row.kind !== 'added' && (
                        <span className="text-oxblood line-through">{row.from}</span>
                      )}
                    </td>
                    <td className="py-1">
                      {row.kind !== 'removed' && <span className="text-moss">{row.to}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
