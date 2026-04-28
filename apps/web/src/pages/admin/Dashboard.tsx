// Phase 26 — admin dashboard. Today's spend, MTD, active users, last sync.
//
// All four stat cards pull from existing admin endpoints — no new server
// surface needed. Quick actions navigate to the page that owns the action.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';

interface Health {
  status: string;
  checks?: Record<string, { ok: boolean; latency_ms?: number }>;
}

interface UsageEvent {
  id: string;
  occurred_at: string;
  user_id: string;
  cost_usd: string | number;
}

interface AdminUser {
  id: string;
  is_active: boolean;
}

interface SyncRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  result: 'preview' | 'success' | 'failed' | 'partial';
  resolved_sha?: string | null;
  triggered_by: string;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfMonth(): Date {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}
function fmtUsd(n: number): string {
  if (!isFinite(n)) return '—';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function AdminDashboard() {
  const { data: health } = useQuery<Health>({
    queryKey: ['health.deep'],
    queryFn: () => api('/api/health/deep'),
    refetchInterval: 30_000,
  });

  const { data: usage } = useQuery<{ events: UsageEvent[] }>({
    queryKey: ['admin', 'usage', 'mtd'],
    queryFn: () => {
      const from = startOfMonth().toISOString().slice(0, 10);
      return api(`/api/admin/usage?from=${from}`);
    },
  });

  const { data: users } = useQuery<{ users: AdminUser[] }>({
    queryKey: ['admin', 'users', 'active'],
    queryFn: () => api('/api/admin/users?active=true&limit=200'),
  });

  const { data: runs } = useQuery<{ runs: SyncRun[] }>({
    queryKey: ['admin', 'skills', 'runs'],
    queryFn: () => api('/api/admin/skills/runs'),
  });

  const today = startOfToday().getTime();
  let todayCost = 0;
  let mtdCost = 0;
  for (const e of usage?.events ?? []) {
    const cost = Number(e.cost_usd) || 0;
    mtdCost += cost;
    if (new Date(e.occurred_at).getTime() >= today) todayCost += cost;
  }
  const activeUserCount = users?.users.length ?? null;
  const lastRun = runs?.runs?.[0];

  return (
    <div>
      <h1 className="font-display text-3xl mb-6">Dashboard</h1>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <Stat
          label="Today"
          value={usage ? fmtUsd(todayCost) : '…'}
          hint={
            usage
              ? `${(usage.events ?? []).filter((e) => new Date(e.occurred_at).getTime() >= today).length} turns`
              : undefined
          }
        />
        <Stat
          label="Month-to-date"
          value={usage ? fmtUsd(mtdCost) : '…'}
          hint={usage ? `${usage.events?.length ?? 0} turns` : undefined}
        />
        <Stat
          label="Active users"
          value={activeUserCount === null ? '…' : String(activeUserCount)}
        />
        <Stat
          label="Last skills sync"
          value={
            lastRun
              ? new Date(lastRun.started_at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : 'never'
          }
          hint={lastRun ? `${lastRun.result} · ${lastRun.triggered_by}` : undefined}
        />
      </div>

      <section className="mb-8">
        <h2 className="font-display text-xl mb-3">Health</h2>
        <div className="border border-ink/10 rounded p-4 bg-white text-sm">
          <pre className="font-mono text-xs">
            {JSON.stringify(health ?? { loading: true }, null, 2)}
          </pre>
        </div>
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/admin/skills"
            className="px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5"
          >
            Refresh skills
          </Link>
          <Link
            to="/admin/models"
            className="px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5"
          >
            Refresh model rates
          </Link>
          <Link
            to="/admin/users"
            className="px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5"
          >
            Invite user
          </Link>
          <Link
            to="/admin/settings"
            className="px-3 py-1.5 border border-ink/20 rounded text-sm hover:bg-ink/5"
          >
            Rotate API key
          </Link>
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
