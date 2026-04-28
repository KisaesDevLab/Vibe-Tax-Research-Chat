// Phase 21 — custom skills authoring (Monaco editor + Claude refinement chat).
//
// Three entry points to the drawer:
//   - "New skill"             → blank draft
//   - "Draft from document"   → upload PDF/DOCX/XLSX/CSV/TXT → server calls
//                                Haiku → drawer pre-filled with proposed
//                                slug/display_name/description/body/keywords
//   - row "edit"              → loaded from GET /:id, slug locked
import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, apiFetch } from '../../lib/api';
import { CustomSkillDrawer, type DrawerState, type DrawerSource } from './CustomSkillDrawer';

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

interface FullCustomSkill extends CustomSkillRow {
  body_md: string;
  routing_keywords: string[];
}

interface DraftFromDocResponse {
  draft: {
    name: string;
    display_name: string;
    description: string;
    body_md: string;
    routing_keywords: string[];
  };
  source: {
    filename: string;
    mime_type: string;
    preview: string;
    full_text: string;
  };
}

const DRAFT_ACCEPT_TYPES =
  '.pdf,.docx,.txt,.md,.html,.htm,.json,.xlsx,.xls,.csv,.tsv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,text/markdown,text/html,application/json';

function emptyState(): DrawerState {
  return {
    name: '',
    display_name: '',
    description: '',
    body: '# New skill\n\nDescribe when this skill applies and what to do.',
    routing_keywords: [],
    include_source_as_reference: false,
  };
}

export function AdminCustomSkillsPage() {
  const qc = useQueryClient();
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<{ custom_skills: CustomSkillRow[] }>({
    queryKey: ['admin', 'custom-skills'],
    queryFn: () => api('/api/admin/custom-skills'),
  });

  const create = useMutation({
    mutationFn: (s: DrawerState) =>
      api('/api/admin/custom-skills', {
        method: 'POST',
        body: JSON.stringify({
          name: s.name,
          display_name: s.display_name,
          description: s.description,
          body_md: s.body,
          routing_keywords: s.routing_keywords,
          references: buildReferences(s),
        }),
      }),
    onSuccess: () => {
      setDrawer(null);
      qc.invalidateQueries({ queryKey: ['admin', 'custom-skills'] });
    },
    onError: (e) => setError(humanize(e)),
  });

  const edit = useMutation({
    mutationFn: (s: DrawerState & { id: string }) =>
      api(`/api/admin/custom-skills/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          display_name: s.display_name,
          description: s.description,
          body_md: s.body,
          routing_keywords: s.routing_keywords,
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
        routing_keywords: r.custom_skill.routing_keywords ?? [],
        include_source_as_reference: false,
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

  async function draftFromDocument(file: File) {
    setError(null);
    setDrafting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // apiFetch is the right tool here — api() forces JSON content-type
      // and would clobber the multipart boundary.
      const res = await apiFetch('/api/admin/custom-skills/draft-from-document', {
        method: 'POST',
        body: fd,
      });
      const r = (await res.json()) as DraftFromDocResponse;
      setDrawer({
        name: r.draft.name,
        display_name: r.draft.display_name,
        description: r.draft.description,
        body: r.draft.body_md,
        routing_keywords: r.draft.routing_keywords ?? [],
        source: {
          filename: r.source.filename,
          full_text: r.source.full_text,
        } satisfies DrawerSource,
        include_source_as_reference: true,
      });
    } catch (e) {
      setError(humanize(e));
    } finally {
      setDrafting(false);
    }
  }

  async function handleSave(s: DrawerState) {
    if (s.id) {
      await edit.mutateAsync({ ...s, id: s.id });
    } else {
      await create.mutateAsync(s);
    }
    return { ok: true };
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Custom skills</h1>
        <div className="flex gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={drafting}
            className="px-3 py-1.5 border border-ink/20 rounded text-sm disabled:opacity-50"
            title="Upload a PDF/DOCX/XLSX/CSV; Claude proposes a draft you can edit."
          >
            {drafting ? 'Drafting…' : 'Draft from document'}
          </button>
          <button
            onClick={() => setDrawer(emptyState())}
            className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
          >
            New skill
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={DRAFT_ACCEPT_TYPES}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void draftFromDocument(f);
            e.target.value = '';
          }
        }}
      />

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
          No custom skills yet — author the first one with the buttons above. Try{' '}
          <span className="font-mono">Draft from document</span> to start from a PDF or spreadsheet.
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
        <CustomSkillDrawer
          state={drawer}
          onChange={setDrawer}
          onClose={() => setDrawer(null)}
          onSave={handleSave}
          saving={create.isPending || edit.isPending}
        />
      )}
    </div>
  );
}

// Bundle the source document as a reference file when the user opted in.
// The skill's references[] is JSON; a single .md entry containing the
// parsed text is enough — the SKILL.md body_md should reference it by
// name (the wizard prompt asks Claude to do this when drafting).
function buildReferences(s: DrawerState): Array<{ filename: string; content: string }> | undefined {
  if (!s.source || !s.include_source_as_reference) return undefined;
  // Force the reference filename into the safe regex the create endpoint
  // enforces (REF_FILENAME_RE: alphanumerics, dots, underscores, hyphens,
  // optional forward-slash subdir). Strip everything else from the
  // original filename and pin it under references/.
  const safe = s.source.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return [{ filename: `references/${safe}.md`, content: s.source.full_text }];
}

function humanize(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.message === 'reserved_name') return 'That name is reserved — pick a different slug.';
    if (e.message === 'publish_failed')
      return 'Publish failed — check the Anthropic key and skill content.';
    if (e.message === 'anthropic_key_missing')
      return 'Save your Anthropic API key under Admin → Settings before publishing or drafting.';
    if (e.message === 'unparseable_document')
      return 'Could not extract text from that file. Scanned PDFs and image-only files are not supported.';
    if (e.message === 'draft_failed')
      return 'Claude could not draft a skill from that document. Try a smaller / cleaner source.';
    if (e.message === 'no_file') return 'Please pick a file before drafting.';
    return e.message;
  }
  return (e as Error).message;
}
