// Phase 26 — admin dashboard. Today's spend, MTD, active users, last sync, etc.
// TODO Phase 26: wire to /api/admin/usage rollups + /api/admin/skills/sync history.
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

interface Health {
  status: string;
  checks?: Record<string, { ok: boolean; latency_ms?: number }>;
}

export function AdminDashboard() {
  const { data: health } = useQuery<Health>({
    queryKey: ['health.deep'],
    queryFn: () => api('/api/health/deep'),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <h1 className="font-display text-3xl mb-6">Dashboard</h1>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <Stat label="Today" value="—" hint="no data yet" />
        <Stat label="Month-to-date" value="—" hint="no data yet" />
        <Stat label="Active users" value="—" hint="no data yet" />
        <Stat label="Last skills sync" value="—" hint="no data yet" />
      </div>

      <section className="mb-8">
        <h2 className="font-display text-xl mb-3">Health</h2>
        <div className="border border-ink/10 rounded p-4 bg-white text-sm">
          <pre className="font-mono text-xs">{JSON.stringify(health ?? { loading: true }, null, 2)}</pre>
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <button className="px-3 py-1.5 border border-ink/20 rounded text-sm">Refresh skills</button>
          <button className="px-3 py-1.5 border border-ink/20 rounded text-sm">Refresh model rates</button>
          <button className="px-3 py-1.5 border border-ink/20 rounded text-sm">Invite user</button>
          <button className="px-3 py-1.5 border border-ink/20 rounded text-sm">Rotate API key</button>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-ink/10 rounded p-4 bg-white">
      <div className="text-xs uppercase tracking-wider text-ink/50">{label}</div>
      <div className="font-display text-2xl mt-1">{value}</div>
      {hint && <div className="text-xs text-ink/40 mt-1">{hint}</div>}
    </div>
  );
}
