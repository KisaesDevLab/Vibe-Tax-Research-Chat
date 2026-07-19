// TP-8 — plans tab on client detail: the client's plans with status.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ClientDTO, PlanDTO } from '@vibe/shared';
import { api } from '../../../lib/api';

export function PlansTab({ client }: { client: ClientDTO }) {
  const { data, isLoading } = useQuery<{ plans: PlanDTO[] }>({
    queryKey: ['plans', { client: client.id }],
    queryFn: () => api(`/api/planning/plans?client_id=${client.id}`),
  });

  if (isLoading) return <div className="text-ink/50">Loading…</div>;
  const rows = data?.plans ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
        No plans for {client.name} yet. Set them as the active client and create one under Planning.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-ink/5">
      {rows.map((p) => (
        <li key={p.id} className="py-3 flex items-baseline gap-3">
          <Link to={`/planning/${p.id}`} className="font-medium hover:underline">
            {p.title}
          </Link>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10">
            {p.status}
          </span>
          <span className="text-xs text-ink/50 ml-auto">
            {new Date(p.updated_at).toLocaleDateString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
