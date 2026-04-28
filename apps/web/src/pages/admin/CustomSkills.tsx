// Phase 21 — custom skills authoring (Monaco editor for Markdown body).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { api, ApiError } from '../../lib/api';

interface CustomSkillRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  is_active: boolean;
  is_always_attached: boolean;
  anthropic_skill_id: string | null;
  anthropic_skill_version: string | null;
}

// The drawer drives both create + edit. `id` distinguishes them: when
// present the drawer is editing an existing row (slug is read-only); when
// absent the drawer is creating a new row.
interface DraftBody {
  id?: string;
  name: string;
  display_name: string;
  description: string;
  body: string;
}

interface FullCustomSkill extends CustomSkillRow {
  body_md: string;
}

export function AdminCustomSkillsPage() {
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<DraftBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ custom_skills: CustomSkillRow[] }>({
    queryKey: ['admin', 'custom-skills'],
    queryFn: () => api('/api/admin/custom-skills'),
  });

  const create = useMutation({
    mutationFn: (payload: DraftBody) =>
      api('/api/admin/custom-skills', {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name,
          display_name: payload.display_name,
          description: payload.description,
          body_md: payload.body,
        }),
      }),
    onSuccess: () => {
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  const edit = useMutation({
    mutationFn: (payload: DraftBody & { id: string }) =>
      api(`/api/admin/custom-skills/${payload.id}`, {
        method: 'PATCH',
        // Slug isn't editable — re-uploading under the same skill_id is
        // what /publish does, but a slug change would orphan the
        // already-uploaded skill. Author a new skill if you need a
        // different slug.
        body: JSON.stringify({
          display_name: payload.display_name,
          description: payload.description,
          body_md: payload.body,
        }),
      }),
    onSuccess: () => {
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  async function openEdit(id: string) {
    setError(null);
    try {
      const r = await api<{ custom_skill: FullCustomSkill }>(`/api/admin/custom-skills/${id}`);
      setDrawer({
        id: r.custom_skill.id,
        name: r.custom_skill.name,
        display_name: r.custom_skill.display_name,
        description: r.custom_skill.description,
        body: r.custom_skill.body_md,
      });
    } catch (e) {
      setError(humanize(e));
    }
  }

  async function publish(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/admin/custom-skills/${id}/publish`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    } catch (e) {
      setError(humanize(e));
    } finally {
      setBusyId(null);
    }
  }
  async function unpublish(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/admin/custom-skills/${id}/unpublish`, { method: 'POST' });
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    } catch (e) {
      setError(humanize(e));
    } finally {
      setBusyId(null);
    }
  }
  async function remove(id: string, name: string) {
    if (!confirm(`Delete custom skill "${name}"? This cannot be undone.`)) return;
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/admin/custom-skills/${id}`, { method: 'DELETE' });
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    } catch (e) {
      setError(humanize(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Custom skills</h1>
        <button
          onClick={() =>
            setDrawer({
              name: '',
              display_name: '',
              description: '',
              body: '# New skill\n\nDescribe when this skill applies and what to do.',
            })
          }
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
        >
          New skill
        </button>
      </div>

      {error && (
        <div className="border border-oxblood/40 bg-oxblood/5 text-oxblood text-sm rounded p-3 mb-4 flex items-baseline justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline whitespace-nowrap">
            Dismiss
          </button>
        </div>
      )}

      {isLoading && <div>Loading…</div>}
      {data && data.custom_skills.length === 0 && (
        <div className="text-sm text-ink/50">
          No custom skills yet — author the first one with the button above.
        </div>
      )}
      {data && data.custom_skills.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
              <th className="py-2">Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Anthropic id</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.custom_skills.map((s) => (
              <tr key={s.id} className="border-b border-ink/5">
                <td className="py-2 font-mono text-xs">{s.name}</td>
                <td className="max-w-md truncate" title={s.description}>
                  {s.description}
                </td>
                <td>{s.is_active ? 'published' : 'draft'}</td>
                <td className="font-mono text-xs text-ink/50">
                  {s.anthropic_skill_id ? `${s.anthropic_skill_id.slice(0, 16)}…` : '—'}
                </td>
                <td>
                  <div className="flex gap-3 justify-end whitespace-nowrap">
                    <button
                      onClick={() => void openEdit(s.id)}
                      disabled={busyId === s.id}
                      className="text-xs underline disabled:opacity-50"
                    >
                      edit
                    </button>
                    {!s.is_active ? (
                      <button
                        onClick={() => void publish(s.id)}
                        disabled={busyId === s.id}
                        className="text-xs underline disabled:opacity-50"
                      >
                        {busyId === s.id ? 'publishing…' : 'publish'}
                      </button>
                    ) : (
                      <button
                        onClick={() => void publish(s.id)}
                        disabled={busyId === s.id}
                        className="text-xs underline disabled:opacity-50"
                        title="Re-upload current content to Anthropic"
                      >
                        {busyId === s.id ? 'publishing…' : 'republish'}
                      </button>
                    )}
                    {s.is_active && (
                      <button
                        onClick={() => void unpublish(s.id)}
                        disabled={busyId === s.id}
                        className="text-xs underline text-oxblood disabled:opacity-50"
                      >
                        {busyId === s.id ? 'unpublishing…' : 'unpublish'}
                      </button>
                    )}
                    <button
                      onClick={() => void remove(s.id, s.name)}
                      disabled={busyId === s.id}
                      className="text-xs underline text-oxblood disabled:opacity-50"
                    >
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {drawer && (
        <div className="fixed inset-0 bg-ink/40">
          <div className="absolute right-0 top-0 bottom-0 w-[680px] bg-paper p-6 overflow-y-auto">
            <h2 className="font-display text-xl mb-4">
              {drawer.id ? `Edit ${drawer.name}` : 'New custom skill'}
            </h2>
            <div className="space-y-3">
              <input
                placeholder="slug (lowercase, hyphens; e.g. firm-billing-rates)"
                value={drawer.name}
                onChange={(e) => setDrawer({ ...drawer, name: e.target.value })}
                disabled={Boolean(drawer.id)}
                className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm disabled:bg-ink/5 disabled:text-ink/50"
                title={drawer.id ? 'Slug is fixed once published' : undefined}
              />
              <input
                placeholder="display name"
                value={drawer.display_name}
                onChange={(e) => setDrawer({ ...drawer, display_name: e.target.value })}
                className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
              />
              <input
                placeholder="description (≤1024 chars, plain text — no HTML/XML)"
                value={drawer.description}
                onChange={(e) => setDrawer({ ...drawer, description: e.target.value })}
                className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
              />
              <div className="border border-ink/20 rounded overflow-hidden">
                <Editor
                  height="400px"
                  defaultLanguage="markdown"
                  value={drawer.body}
                  onChange={(v) => setDrawer({ ...drawer, body: v ?? '' })}
                />
              </div>
              {drawer.id && (
                <p className="text-xs text-ink/50">
                  Saving stores the draft in the appliance database. Click{' '}
                  <span className="font-mono">republish</span> on the row afterwards to push the new
                  content to Anthropic.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setDrawer(null)} className="px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                onClick={() => {
                  if (drawer.id) {
                    edit.mutate({ ...drawer, id: drawer.id });
                  } else {
                    create.mutate(drawer);
                  }
                }}
                disabled={
                  create.isPending ||
                  edit.isPending ||
                  drawer.name.length < 3 ||
                  drawer.display_name.length < 1 ||
                  drawer.description.length < 1 ||
                  drawer.body.length < 1
                }
                className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
              >
                {drawer.id
                  ? edit.isPending
                    ? 'Saving…'
                    : 'Save changes'
                  : create.isPending
                    ? 'Saving…'
                    : 'Save draft'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function humanize(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === 'reserved_name') return 'That name is reserved — pick a different slug.';
    if (e.message === 'publish_failed')
      return 'Publish failed — check the Anthropic key and skill content.';
    if (e.message === 'anthropic_key_missing')
      return 'Save your Anthropic API key under Admin → Settings before publishing.';
    return e.message;
  }
  return (e as Error).message;
}
