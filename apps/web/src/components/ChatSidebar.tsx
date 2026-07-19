// Phase 13 — chat list sidebar grouped by Today / Yesterday / Earlier.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useFontSize } from '../lib/font-size';
import { useActiveClient } from '../lib/active-client';
import { useAppConfig } from '../lib/app-config';
import { BulkArchiveDialog } from './BulkArchiveDialog';
import type { ChatDTO } from '@vibe/shared';

interface ChatSidebarProps {
  // Mobile-drawer wiring. On screens < md the sidebar is rendered as a
  // fixed off-canvas panel; the parent owns the open/close state so the
  // header's hamburger and the in-sidebar nav links can both flip it.
  // Desktop (md+) ignores both props and shows the sidebar inline.
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function ChatSidebar({ mobileOpen = false, onClose }: ChatSidebarProps = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { chatId } = useParams<{ chatId?: string }>();
  const { activeClient } = useActiveClient();
  // TP-11 — multi-select bulk archive (planning module only).
  const { config } = useAppConfig();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkArchive, setShowBulkArchive] = useState(false);

  const { data } = useQuery<{ chats: ChatDTO[] }>({
    queryKey: ['chats'],
    queryFn: () => api('/api/chats'),
  });

  const create = useMutation({
    // TP-2 — new chats soft-link to the active client chip when one is set.
    mutationFn: () =>
      api<{ chat: ChatDTO }>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(activeClient ? { client_id: activeClient.id } : {}),
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['chats'] });
      onClose?.();
      navigate(`/research/${r.chat.id}`);
    },
  });

  const groups = useMemo(() => groupChats(data?.chats ?? []), [data]);

  return (
    <>
      {/* Mobile-only backdrop. md:hidden keeps it out of the desktop layout
          entirely. Tapping the backdrop closes the drawer. */}
      <div
        className={`fixed inset-0 z-20 bg-ink/30 md:hidden transition-opacity duration-200 ${
          mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`fixed inset-y-0 left-0 z-30 w-[260px] bg-paper border-r border-ink/10 flex flex-col min-h-0 transform transition-transform duration-200 md:static md:flex-none md:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <div className="p-3 border-b border-ink/10 flex items-center justify-between">
          <Link to="/research" className="font-display tracking-tight" onClick={onClose}>
            Vibe
          </Link>
          <button
            onClick={() => create.mutate()}
            className="text-xs px-2 py-1 bg-ink text-paper rounded"
          >
            + New
          </button>
        </div>
        <div className="overflow-y-auto flex-1">
          {(['Today', 'Yesterday', 'Earlier'] as const).map((g) => {
            const items = groups[g];
            if (!items || items.length === 0) return null;
            return (
              <div key={g} className="mt-2">
                <div className="px-3 text-[10px] uppercase tracking-wider text-ink/40 mb-1">
                  {g}
                </div>
                {items.map((c) =>
                  selectMode ? (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-ink/5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setSelected(next);
                        }}
                      />
                      <span className="truncate">{c.title}</span>
                    </label>
                  ) : (
                    <Link
                      key={c.id}
                      to={`/research/${c.id}`}
                      onClick={onClose}
                      className={`block px-3 py-1.5 text-sm truncate hover:bg-ink/5 ${chatId === c.id ? 'bg-ink/10' : ''}`}
                    >
                      {c.client_id && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-moss mr-1.5 align-middle"
                          title="Linked to a client"
                        />
                      )}
                      {c.title}
                    </Link>
                  ),
                )}
              </div>
            );
          })}
        </div>
        {config.planning_enabled && (
          <div className="px-3 py-2 border-t border-ink/10 flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => {
                setSelectMode((v) => !v);
                setSelected(new Set());
              }}
              className="underline text-ink/50 hover:text-ink"
            >
              {selectMode ? 'Cancel selection' : 'Select…'}
            </button>
            {selectMode && selected.size > 0 && (
              <button
                type="button"
                onClick={() => setShowBulkArchive(true)}
                className="ml-auto px-2 py-1 bg-ink text-paper rounded"
              >
                Archive {selected.size}…
              </button>
            )}
          </div>
        )}
        <div className="p-3 border-t border-ink/10 text-xs text-ink/40 space-y-2">
          <FontSizeSelector />
          <Link to="/admin" className="underline" onClick={onClose}>
            Admin
          </Link>
        </div>
      </aside>
      {showBulkArchive && (
        <BulkArchiveDialog
          chatIds={Array.from(selected)}
          onClose={() => setShowBulkArchive(false)}
          onDone={() => {
            setShowBulkArchive(false);
            setSelectMode(false);
            setSelected(new Set());
            void qc.invalidateQueries({ queryKey: ['chats'] });
          }}
        />
      )}
    </>
  );
}

// Aa- / Aa / Aa+ trio matches the Vibe-MyBooks + Vibe-Trial-Balance pattern.
// Persists to localStorage and propagates cross-tab via useFontSize().
export function FontSizeSelector() {
  const { size, bump, setSize } = useFontSize();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="uppercase tracking-wider text-ink/40">font</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Decrease font size"
          onClick={() => bump(-1)}
          className="w-6 h-6 grid place-items-center border border-ink/15 rounded hover:bg-ink/5"
        >
          <span className="text-[10px]">A−</span>
        </button>
        <button
          type="button"
          aria-label="Reset font size"
          onClick={() => setSize('md')}
          className="w-6 h-6 grid place-items-center border border-ink/15 rounded text-[10px] uppercase hover:bg-ink/5"
          title={`Current: ${size}`}
        >
          {size}
        </button>
        <button
          type="button"
          aria-label="Increase font size"
          onClick={() => bump(1)}
          className="w-6 h-6 grid place-items-center border border-ink/15 rounded hover:bg-ink/5"
        >
          <span className="text-[12px]">A+</span>
        </button>
      </div>
    </div>
  );
}

function groupChats(chats: ChatDTO[]): Record<'Today' | 'Yesterday' | 'Earlier', ChatDTO[]> {
  const out = { Today: [] as ChatDTO[], Yesterday: [] as ChatDTO[], Earlier: [] as ChatDTO[] };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  for (const c of chats) {
    const t = new Date(c.updated_at).getTime();
    if (t >= today) out.Today.push(c);
    else if (t >= yesterday) out.Yesterday.push(c);
    else out.Earlier.push(c);
  }
  return out;
}
