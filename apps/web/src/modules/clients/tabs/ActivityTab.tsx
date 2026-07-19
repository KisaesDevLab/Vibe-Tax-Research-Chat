// TP-3 — activity tab: the client's slice of the audit log.
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export function ActivityTab({ clientId }: { clientId: string }) {
  const { data, isLoading } = useQuery<{ activity: AuditRow[] }>({
    queryKey: ['client-activity', clientId],
    queryFn: () => api(`/api/clients/${clientId}/activity`),
  });

  if (isLoading) return <div className="text-ink/50">Loading…</div>;
  const rows = data?.activity ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
        No recorded activity yet.
      </div>
    );
  }
  return (
    <ul className="text-sm divide-y divide-ink/5">
      {rows.map((r) => (
        <li key={r.id} className="py-2 flex items-baseline gap-3">
          <span className="text-xs text-ink/40 whitespace-nowrap w-36 shrink-0">
            {new Date(r.occurred_at).toLocaleString()}
          </span>
          <span className="font-mono text-xs">{r.action}</span>
        </li>
      ))}
    </ul>
  );
}
