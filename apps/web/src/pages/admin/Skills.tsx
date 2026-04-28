// Phase 10 — admin skills page (sync lifecycle).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface SkillRow {
  skill_id: string;
  local_slug: string;
  display_name: string;
  current_version: string;
  status_field: string;
  is_active: boolean;
  is_always_attached: boolean;
}

interface SyncDiff {
  added: Array<{ slug: string }>;
  updated: Array<{ slug: string; old_sha: string; new_sha: string }>;
  removed: Array<{ slug: string }>;
  unchanged_count: number;
  resolved_sha: string;
}

export function AdminSkillsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<{ skills: SkillRow[] }>({
    queryKey: ['admin', 'skills'],
    queryFn: () => api('/api/admin/skills'),
  });

  const [diff, setDiff] = useState<{ run_id: string; diff: SyncDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: () => api<{ run_id: string; diff: SyncDiff }>('/api/admin/skills/sync', { method: 'POST' }),
    onSuccess: (d) => setDiff(d),
    onError: (e) => setError((e as Error).message),
  });

  const apply = useMutation({
    mutationFn: () =>
      api('/api/admin/skills/sync/apply', {
        method: 'POST',
        body: JSON.stringify({ run_id: diff!.run_id }),
      }),
    onSuccess: () => {
      setDiff(null);
      qc.invalidateQueries({ queryKey: ['admin', 'skills'] });
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Skills</h1>
        <button onClick={() => sync.mutate()} className="px-3 py-1.5 border border-ink/20 rounded text-sm">
          Sync from upstream
        </button>
      </div>

      {error && <div className="text-oxblood mb-4 text-sm">{error}</div>}

      {diff && (
        <div className="mb-6 border border-gold/40 bg-gold/5 p-4 rounded">
          <div className="font-display text-lg mb-2">
            Pending changes <span className="font-mono text-xs text-ink/60">@ {diff.diff.resolved_sha.slice(0, 8)}</span>
          </div>
          <div className="text-sm">
            <div>+{diff.diff.added.length} added · ~{diff.diff.updated.length} updated · −{diff.diff.removed.length} removed · {diff.diff.unchanged_count} unchanged</div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs font-mono">
            <DiffList title="added" items={diff.diff.added.map((a) => a.slug)} cls="text-moss" />
            <DiffList title="updated" items={diff.diff.updated.map((u) => u.slug)} cls="text-gold" />
            <DiffList title="removed" items={diff.diff.removed.map((r) => r.slug)} cls="text-oxblood" />
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => apply.mutate()} className="px-3 py-1.5 bg-ink text-paper rounded text-sm">
              Apply
            </button>
            <button onClick={() => setDiff(null)} className="px-3 py-1.5 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
            <th className="py-2">Skill</th>
            <th>Version</th>
            <th>Status</th>
            <th>Always-attached</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {data?.skills.map((s) => (
            <tr key={s.skill_id} className="border-b border-ink/5">
              <td className="py-2">
                <div>{s.display_name}</div>
                <div className="font-mono text-xs text-ink/50">{s.local_slug}</div>
              </td>
              <td className="font-mono text-xs">{s.current_version}</td>
              <td>{s.status_field}</td>
              <td>{s.is_always_attached ? 'yes' : 'no'}</td>
              <td>{s.is_active ? 'yes' : 'no'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiffList({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">{title}</div>
      <ul className={`space-y-0.5 ${cls}`}>
        {items.length === 0 && <li className="text-ink/40">—</li>}
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
