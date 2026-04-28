// Phase 24 — usage analytics page.
//
// Costs shown here are *estimates* — the appliance computes them locally
// from per-token rates in the models registry × the usage block returned
// by Anthropic. Actual billing happens against the customer's Anthropic
// console and may differ (mid-cycle rate updates, beta-tool surcharges,
// rounding, etc.). Every cost label says "est." so admins don't mistake
// these numbers for invoice totals.
import { useQuery } from '@tanstack/react-query';
import { api, apiUrl } from '../../lib/api';

interface UsageEvent {
  occurred_at: string;
  user_id: string;
  user_email: string | null;
  user_display_name: string | null;
  chat_id: string | null;
  message_id: string | null;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
}

interface Total {
  model_id: string;
  messages: number;
  total_cost: number;
}

export function AdminUsagePage() {
  const { data: totals } = useQuery<{ totals: Total[] }>({
    queryKey: ['admin', 'usage', 'totals'],
    queryFn: () => api('/api/admin/usage/totals'),
  });
  const { data: events } = useQuery<{ events: UsageEvent[] }>({
    queryKey: ['admin', 'usage', 'events'],
    queryFn: () => api('/api/admin/usage'),
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-3xl">Usage</h1>
        <a
          href={apiUrl('/api/admin/usage?format=csv')}
          className="px-3 py-1.5 border border-ink/20 rounded text-sm"
        >
          Download CSV
        </a>
      </div>

      <p className="text-xs text-ink/60 mb-4 max-w-3xl">
        Costs below are <strong>estimates</strong>, computed from the registered per-model rates and
        Anthropic&apos;s usage block. Use them for trend / budget tracking — actual billed amounts
        come from your Anthropic console.
      </p>

      <section className="mb-8">
        <h2 className="font-display text-xl mb-3">Per-model totals</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-ink/50 border-b border-ink/10">
              <th className="py-2">Model</th>
              <th>Messages</th>
              <th>Total est. cost</th>
            </tr>
          </thead>
          <tbody>
            {totals?.totals.map((t) => (
              <tr key={t.model_id} className="border-b border-ink/5">
                <td className="py-2 font-mono text-xs">{t.model_id}</td>
                <td>{t.messages}</td>
                <td className="font-mono">${Number(t.total_cost ?? 0).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">Recent events</h2>
        <div className="text-xs font-mono overflow-auto max-h-[480px] border border-ink/10 rounded">
          <table className="w-full">
            <thead>
              <tr className="text-left bg-ink/5">
                <th className="px-2 py-1">When</th>
                <th>User</th>
                <th>Model</th>
                <th>In</th>
                <th>Out</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {events?.events.map((e, i) => (
                <tr key={i} className="border-b border-ink/5">
                  <td className="px-2 py-1">{new Date(e.occurred_at).toLocaleString()}</td>
                  <td title={e.user_id}>{userLabel(e)}</td>
                  <td>{e.model_id}</td>
                  <td>{e.input_tokens}</td>
                  <td>{e.output_tokens}</td>
                  <td>${Number(e.cost_usd).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// Prefer email; fall back to display_name; finally the truncated user_id.
// A null user_email + display_name means the user was hard-deleted — that's
// rare (admin/users.ts soft-deletes) but legal under the schema's SET NULL
// FK behavior, so handle it gracefully.
function userLabel(e: UsageEvent): string {
  if (e.user_email) return e.user_email;
  if (e.user_display_name) return e.user_display_name;
  return `(deleted user · ${e.user_id.slice(0, 8)})`;
}
