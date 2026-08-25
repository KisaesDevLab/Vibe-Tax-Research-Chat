// TP-3 — client detail with Overview · Plans · Research · Documents ·
// Activity tabs. Plans/Documents are empty states until TP-8/TP-9;
// Research fills with archives in TP-11.
import { useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientDTO } from '@vibe/shared';
import { api } from '../../lib/api';
import { useActiveClient } from '../../lib/active-client';
import { MergeClientDialog } from './MergeClientDialog';
import { OverviewTab } from './tabs/OverviewTab';
import { ActivityTab } from './tabs/ActivityTab';
import { ResearchTab } from './tabs/ResearchTab';
import { PlansTab } from './tabs/PlansTab';
import { DocumentsTab } from './tabs/DocumentsTab';
import { FactsTab } from './tabs/FactsTab';

export interface ClientDetail {
  client: ClientDTO;
  counts: { chats: number; plans: number; archives: number; documents: number };
}

const TABS = ['overview', 'facts', 'plans', 'research', 'documents', 'activity'] as const;
export type ClientTab = (typeof TABS)[number];

export function ClientDetailPage() {
  const { clientId, tab } = useParams<{ clientId: string; tab?: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { activeClient, setActiveClient } = useActiveClient();
  const [showMerge, setShowMerge] = useState(false);

  const activeTab: ClientTab = TABS.includes(tab as ClientTab) ? (tab as ClientTab) : 'overview';

  const { data, isLoading } = useQuery<ClientDetail>({
    queryKey: ['client', clientId],
    queryFn: () => api(`/api/clients/${clientId}`),
    enabled: Boolean(clientId),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/clients/${clientId}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (activeClient?.id === clientId) setActiveClient(null);
      qc.invalidateQueries({ queryKey: ['clients'] });
      navigate('/clients');
    },
  });

  if (isLoading) return <div className="p-8 text-ink/50">Loading…</div>;
  if (!data) return <div className="p-8 text-ink/50">Client not found.</div>;
  const { client, counts } = data;

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8 max-w-4xl">
      <div className="text-xs text-ink/40 mb-1">
        <Link to="/clients" className="hover:underline">
          Clients
        </Link>{' '}
        / {client.name}
      </div>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="font-display text-3xl">{client.name}</h1>
          <div className="text-sm text-ink/60">{client.entity_type}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setActiveClient({ id: client.id, name: client.name })}
            disabled={activeClient?.id === client.id}
            className="px-3 py-1.5 border border-moss/50 text-moss rounded text-sm disabled:opacity-50"
          >
            {activeClient?.id === client.id ? 'Active client' : 'Set active'}
          </button>
          <button
            onClick={() => setShowMerge(true)}
            className="px-3 py-1.5 border border-ink/20 rounded text-sm"
          >
            Merge…
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete client “${client.name}”? Linked chats are kept.`)) {
                remove.mutate();
              }
            }}
            className="px-3 py-1.5 border border-oxblood text-oxblood rounded text-sm"
          >
            Delete
          </button>
        </div>
      </div>

      <nav className="flex gap-1 border-b border-ink/10 mb-4 text-sm">
        {TABS.map((t) => (
          <NavLink
            key={t}
            to={`/clients/${client.id}/${t}`}
            replace
            className={() =>
              `px-3 py-1.5 capitalize border-b-2 -mb-px ${
                activeTab === t
                  ? 'border-ink font-medium'
                  : 'border-transparent text-ink/50 hover:text-ink'
              }`
            }
          >
            {t}
          </NavLink>
        ))}
      </nav>

      {activeTab === 'overview' && <OverviewTab detail={data} />}
      {activeTab === 'facts' && <FactsTab client={client} />}
      {activeTab === 'plans' && <PlansTab client={client} />}
      {activeTab === 'research' && <ResearchTab client={client} counts={counts} />}
      {activeTab === 'documents' && <DocumentsTab client={client} />}
      {activeTab === 'activity' && <ActivityTab clientId={client.id} />}

      {showMerge && <MergeClientDialog client={client} onClose={() => setShowMerge(false)} />}
    </div>
  );
}
