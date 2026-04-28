// Phase 10 — admin skills page (sync lifecycle).
//
// The upstream skills pack is still pre-1.0 and ships from `main` rather
// than tags, so the Source panel lets admins flip pin_type/pin_value at
// sync-time. Whatever they pick rides through to runDryRun via the request
// body — the env values are only the fallback for the nightly cron.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';

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

type PinType = 'tag' | 'branch' | 'sha';

export function AdminSkillsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<{ skills: SkillRow[] }>({
    queryKey: ['admin', 'skills'],
    queryFn: () => api('/api/admin/skills'),
  });

  const [pinType, setPinType] = useState<PinType>('branch');
  const [pinValue, setPinValue] = useState<string>('main');
  const [diff, setDiff] = useState<{ run_id: string; diff: SyncDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: () =>
      api<{ run_id: string; diff: SyncDiff }>('/api/admin/skills/sync', {
        method: 'POST',
        body: JSON.stringify({ pin_type: pinType, pin_value: pinValue }),
      }),
    onSuccess: (d) => {
      setError(null);
      setDiff(d);
    },
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
    onError: (e) => {
      // Surface 412 / 502 with a friendlier banner. The key-missing case is
      // the most common stumble in first-run setup.
      if (e instanceof ApiError && e.status === 412 && e.message === 'anthropic_key_missing') {
        setError('ANTHROPIC_KEY_MISSING');
      } else {
        setError((e as Error).message);
      }
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Skills</h1>
      </div>

      <section className="border border-ink/10 rounded p-4 bg-white mb-6">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="font-display text-lg">Source</div>
          <div className="font-mono text-xs text-ink/50">
            github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Pin type</div>
            <select
              value={pinType}
              onChange={(e) => setPinType(e.target.value as PinType)}
              className="px-3 py-2 border border-ink/20 rounded text-sm"
            >
              <option value="branch">branch</option>
              <option value="tag">tag</option>
              <option value="sha">sha</option>
            </select>
          </label>
          <label className="block flex-1 min-w-[200px]">
            <div className="text-xs uppercase tracking-wider text-ink/50 mb-1">Pin value</div>
            <input
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value)}
              placeholder={pinType === 'branch' ? 'main' : pinType === 'tag' ? 'v1.0.0' : 'sha…'}
              className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
            />
          </label>
          <button
            onClick={() => sync.mutate()}
            disabled={sync.isPending || !pinValue}
            className="px-3 py-2 bg-ink text-paper rounded text-sm disabled:opacity-50"
          >
            {sync.isPending ? 'Syncing…' : 'Sync from upstream'}
          </button>
        </div>
        <p className="text-xs text-ink/50 mt-2">
          The upstream pack ships from <span className="font-mono">main</span> — there are no
          release tags yet. Pick a branch or commit SHA. Sync runs a dry-run first; you review the
          diff before applying.
        </p>
      </section>

      {error === 'ANTHROPIC_KEY_MISSING' ? (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4">
          Set your Anthropic API key before applying. The sync uploads each skill via{' '}
          <span className="font-mono">POST /v1/skills</span> and needs a working key.{' '}
          <Link to="/admin/settings" className="underline font-display">
            Open Settings →
          </Link>
        </div>
      ) : error ? (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4">
          {error}
        </div>
      ) : null}

      {diff && (
        <div className="mb-6 border border-gold/40 bg-gold/5 p-4 rounded">
          <div className="font-display text-lg mb-2">
            Pending changes{' '}
            <span className="font-mono text-xs text-ink/60">
              @ {diff.diff.resolved_sha.slice(0, 8)}
            </span>
          </div>
          <div className="text-sm">
            <div>
              +{diff.diff.added.length} added · ~{diff.diff.updated.length} updated · −
              {diff.diff.removed.length} removed · {diff.diff.unchanged_count} unchanged
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs font-mono">
            <DiffList title="added" items={diff.diff.added.map((a) => a.slug)} cls="text-moss" />
            <DiffList
              title="updated"
              items={diff.diff.updated.map((u) => u.slug)}
              cls="text-gold"
            />
            <DiffList
              title="removed"
              items={diff.diff.removed.map((r) => r.slug)}
              cls="text-oxblood"
            />
          </div>
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => apply.mutate()}
              disabled={apply.isPending}
              className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
            >
              {apply.isPending ? 'Applying…' : 'Apply'}
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
          {data?.skills.length === 0 && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-ink/50 text-sm">
                No skills yet. Run a sync above to ingest the pack from upstream.
              </td>
            </tr>
          )}
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
