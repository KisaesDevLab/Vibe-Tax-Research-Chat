// TP-3 — overview: counts + editable contacts/entity details.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../../../lib/api';
import type { ClientDetail } from '../ClientDetailPage';

export function OverviewTab({ detail }: { detail: ClientDetail }) {
  const { client, counts } = detail;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Research chats" value={counts.chats} />
        <StatCard label="Archives" value={counts.archives} />
        <StatCard label="Plans" value={counts.plans} />
        <StatCard label="Documents" value={counts.documents} />
      </div>
      <ContactsEditor client={client} />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-ink/10 rounded p-4 bg-white">
      <div className="text-2xl font-display">{value}</div>
      <div className="text-xs uppercase tracking-wider text-ink/40">{label}</div>
    </div>
  );
}

function ContactsEditor({ client }: { client: ClientDTO }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(client.contacts ?? [], null, 2));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (contacts: unknown) =>
      api(`/api/clients/${client.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ contacts }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client', client.id] });
      setEditing(false);
      setError(null);
    },
    onError: (err) => setError((err as Error).message),
  });

  const contacts = client.contacts ?? [];

  return (
    <section className="border border-ink/10 rounded p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display text-lg">Contacts</h2>
        {!editing && (
          <button
            onClick={() => {
              setDraft(JSON.stringify(contacts, null, 2));
              setEditing(true);
            }}
            className="text-sm text-ink/60 hover:text-ink underline"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full font-mono text-xs border border-ink/20 rounded p-2"
          />
          {error && <div className="text-oxblood text-sm mt-1">{error}</div>}
          <div className="flex justify-end gap-2 mt-2">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 border border-ink/20 rounded text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                try {
                  save.mutate(JSON.parse(draft));
                } catch {
                  setError('Invalid JSON');
                }
              }}
              className="px-3 py-1.5 bg-ink text-paper rounded text-sm"
            >
              Save
            </button>
          </div>
        </div>
      ) : contacts.length === 0 ? (
        <div className="text-sm text-ink/40">No contacts recorded.</div>
      ) : (
        <ul className="text-sm space-y-1">
          {contacts.map((c, i) => (
            <li key={i} className="flex flex-wrap gap-x-3">
              <span>{c.name ?? '—'}</span>
              {c.role && <span className="text-ink/50">{c.role}</span>}
              {c.email && <span className="text-ink/50">{c.email}</span>}
              {c.phone && <span className="text-ink/50">{c.phone}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
