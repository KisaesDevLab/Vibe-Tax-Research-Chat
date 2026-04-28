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
import { Markdown } from '../../components/Markdown';

interface SkillRow {
  skill_id: string;
  local_slug: string;
  display_name: string;
  current_version: string;
  status_field: string;
  is_active: boolean;
  is_always_attached: boolean;
}

interface SkillFileEntry {
  rel_path: string;
  size_bytes: number;
  is_text: boolean;
  content?: string;
  truncated?: boolean;
}

interface SkillContentResponse {
  skill: SkillRow & {
    description: string;
    category: string | null;
    routing_keywords: string[];
    github_path: string | null;
    github_sha: string | null;
  };
  body_md: string;
  files: SkillFileEntry[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
  const [viewing, setViewing] = useState<SkillContentResponse | null>(null);
  const [viewBusy, setViewBusy] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  async function openView(row: SkillRow) {
    // Use local_slug — it's the stable, human-readable identifier. The
    // backend lookup accepts either skill_id or local_slug, but slug avoids
    // any URL-encoding edge case if Anthropic ever ships ids with awkward
    // characters and is much easier to recognize in network logs.
    const lookupId = row.local_slug ?? row.skill_id;
    setViewBusy(lookupId);
    setViewError(null);
    try {
      const r = await api<SkillContentResponse>(`/api/admin/skills/${lookupId}/content`);
      setViewing(r);
    } catch (e) {
      if (e instanceof ApiError && e.message === 'workspace_missing') {
        setViewError(
          'Skill source not on disk. Run a sync above to populate the workspace, then try again.',
        );
      } else if (e instanceof ApiError && e.message === 'no_github_path') {
        setViewError(
          'This skill has no on-disk source. (Custom skills authored in the appliance are visible under Admin → Custom skills.)',
        );
      } else if (e instanceof ApiError && e.message === 'not_found') {
        const requested =
          typeof e.body === 'object' && e.body !== null && 'requested_id' in e.body
            ? String((e.body as Record<string, unknown>).requested_id)
            : lookupId;
        setViewError(
          `Couldn't find a skill matching "${requested}" in the database. The list may be stale — try refreshing the page.`,
        );
      } else {
        setViewError((e as Error).message);
      }
    } finally {
      setViewBusy(null);
    }
  }

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

      {viewError && (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4 flex items-baseline justify-between gap-3">
          <span>{viewError}</span>
          <button onClick={() => setViewError(null)} className="underline whitespace-nowrap">
            Dismiss
          </button>
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.skills.length === 0 && (
            <tr>
              <td colSpan={6} className="py-6 text-center text-ink/50 text-sm">
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
              <td className="text-right">
                <button
                  onClick={() => void openView(s)}
                  disabled={viewBusy === (s.local_slug ?? s.skill_id)}
                  className="text-xs underline disabled:opacity-50"
                >
                  {viewBusy === (s.local_slug ?? s.skill_id) ? 'loading…' : 'view'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {viewing && <SkillContentDrawer data={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// Read-only viewer for a routed pack skill. Shows the SKILL.md body
// rendered as Markdown plus a collapsible list of the references/,
// scripts/, shared/, examples/ files that travel with it. Inline text
// content is included up to MAX_INLINE_FILE_BYTES per file (server
// caps total to ~4 MB).
function SkillContentDrawer({
  data,
  onClose,
}: {
  data: SkillContentResponse;
  onClose: () => void;
}) {
  const [showFrontmatter, setShowFrontmatter] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);

  // The SKILL.md ships with YAML frontmatter ('---\n...\n---\n'); the
  // Markdown component would render '---' as a horizontal rule. Strip
  // for the default view and offer a toggle for admins who want to see
  // the raw frontmatter.
  const fmMatch = data.body_md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const frontmatterText = fmMatch?.[1] ?? null;
  const bodyOnly = fmMatch?.[2] ?? data.body_md;

  return (
    <div className="fixed inset-0 bg-ink/40 z-30">
      <div className="absolute right-0 top-0 bottom-0 w-[820px] bg-paper p-6 overflow-y-auto shadow-2xl">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="font-display text-xl">{data.skill.display_name}</h2>
          <button onClick={onClose} className="text-sm text-ink/50 hover:text-ink">
            Close
          </button>
        </div>
        <div className="font-mono text-xs text-ink/50 mb-4 flex flex-wrap gap-x-4 gap-y-1">
          <span>{data.skill.local_slug}</span>
          <span>v{data.skill.current_version}</span>
          {data.skill.github_sha && <span>sha {data.skill.github_sha.slice(0, 8)}</span>}
          <span>{data.skill.status_field}</span>
        </div>
        {data.skill.description && (
          <p className="text-sm text-ink/70 mb-4">{data.skill.description}</p>
        )}
        {data.skill.routing_keywords?.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1">
            {data.skill.routing_keywords.map((k) => (
              <span
                key={k}
                className="text-[10px] uppercase tracking-wider bg-ink/5 text-ink/60 px-1.5 py-0.5 rounded font-mono"
              >
                {k}
              </span>
            ))}
          </div>
        )}

        {frontmatterText && (
          <div className="mb-4">
            <button
              onClick={() => setShowFrontmatter((v) => !v)}
              className="text-xs underline text-ink/60 hover:text-ink"
            >
              {showFrontmatter ? 'Hide' : 'Show'} frontmatter
            </button>
            {showFrontmatter && (
              <pre className="mt-2 bg-ink/5 border border-ink/10 rounded p-3 text-xs font-mono overflow-auto max-h-48">
                {frontmatterText}
              </pre>
            )}
          </div>
        )}

        <section className="mb-6 border border-ink/10 rounded p-4 bg-white">
          <div className="text-xs uppercase tracking-wider text-ink/50 mb-2">SKILL.md</div>
          <Markdown>{bodyOnly}</Markdown>
        </section>

        <section className="border border-ink/10 rounded bg-white">
          <header className="px-4 py-2 border-b border-ink/10 text-sm font-display flex items-baseline justify-between">
            <span>References & assets</span>
            <span className="text-xs text-ink/50 font-mono">{data.files.length} file(s)</span>
          </header>
          {data.files.length === 0 ? (
            <div className="px-4 py-6 text-center text-ink/50 text-sm">
              This skill has no reference files.
            </div>
          ) : (
            <ul className="divide-y divide-ink/5">
              {data.files.map((f) => {
                const expandable = f.is_text && typeof f.content === 'string';
                const isOpen = openFile === f.rel_path;
                return (
                  <li key={f.rel_path}>
                    <button
                      type="button"
                      onClick={() => expandable && setOpenFile(isOpen ? null : f.rel_path)}
                      disabled={!expandable}
                      className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-ink/[0.02] disabled:opacity-60"
                    >
                      <span className="font-mono text-xs flex-1 truncate">{f.rel_path}</span>
                      <span className="text-xs text-ink/50">{formatBytes(f.size_bytes)}</span>
                      {!f.is_text && <span className="text-xs text-ink/40">binary</span>}
                      {f.truncated && <span className="text-xs text-gold">large</span>}
                      {expandable && (
                        <span className="text-xs text-ink/40">{isOpen ? '▾' : '▸'}</span>
                      )}
                    </button>
                    {isOpen && expandable && (
                      <pre className="bg-ink/[0.03] border-t border-ink/5 px-4 py-3 text-xs font-mono overflow-auto max-h-[420px] whitespace-pre">
                        {f.content}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
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
