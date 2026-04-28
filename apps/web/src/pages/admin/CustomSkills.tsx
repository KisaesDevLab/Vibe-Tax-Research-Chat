// Phase 21 — custom skills authoring (Monaco editor for Markdown body).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { api } from '../../lib/api';

interface CustomSkillRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  is_active: boolean;
  is_always_attached: boolean;
}

export function AdminCustomSkillsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<{ custom_skills: CustomSkillRow[] }>({
    queryKey: ['admin', 'custom-skills'],
    queryFn: () => api('/api/admin/custom-skills'),
  });

  const [drawer, setDrawer] = useState<{ name: string; display_name: string; description: string; body: string } | null>(null);

  const create = useMutation({
    mutationFn: (payload: typeof drawer) =>
      api('/api/admin/custom-skills', {
        method: 'POST',
        body: JSON.stringify({
          name: payload!.name,
          display_name: payload!.display_name,
          description: payload!.description,
          body_md: payload!.body,
        }),
      }),
    onSuccess: () => {
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    },
  });

  const publish = useMutation({
    mutationFn: (id: string) => api(`/api/admin/custom-skills/${id}/publish`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] }),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Custom skills</h1>
        <button
          onClick={() => setDrawer({ name: '', display_name: '', description: '', body: '# New skill\n\n…' })}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
        >
          New skill
        </button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
            <th className="py-2">Name</th>
            <th>Description</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.custom_skills.map((s) => (
            <tr key={s.id} className="border-b border-ink/5">
              <td className="py-2 font-mono text-xs">{s.name}</td>
              <td>{s.description}</td>
              <td>{s.is_active ? 'published' : 'draft'}</td>
              <td>
                {!s.is_active && (
                  <button onClick={() => publish.mutate(s.id)} className="text-xs underline">
                    publish
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {drawer && (
        <div className="fixed inset-0 bg-ink/40">
          <div className="absolute right-0 top-0 bottom-0 w-[680px] bg-paper p-6 overflow-y-auto">
            <h2 className="font-display text-xl mb-4">New custom skill</h2>
            <div className="space-y-3">
              <input
                placeholder="slug (lowercase, hyphens)"
                value={drawer.name}
                onChange={(e) => setDrawer({ ...drawer, name: e.target.value })}
                className="w-full px-3 py-2 border border-ink/20 rounded font-mono text-sm"
              />
              <input
                placeholder="display name"
                value={drawer.display_name}
                onChange={(e) => setDrawer({ ...drawer, display_name: e.target.value })}
                className="w-full px-3 py-2 border border-ink/20 rounded text-sm"
              />
              <input
                placeholder="description (≤1024 chars)"
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
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setDrawer(null)} className="px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                onClick={() => create.mutate(drawer)}
                className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
              >
                Save draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
