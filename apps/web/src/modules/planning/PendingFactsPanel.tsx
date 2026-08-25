// TP-8a — the plan's pending chat-confirmed facts, with dismiss and
// "Promote to client" (one new client fact-pattern version for the whole
// pending set; unpathed statements land as answered open questions).
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanPendingFactDTO } from '@vibe/shared';
import { api } from '../../lib/api';

export function PendingFactsPanel({ planId, clientId }: { planId: string; clientId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data } = useQuery<{ facts: PlanPendingFactDTO[] }>({
    queryKey: ['plan-pending-facts', planId],
    queryFn: () => api(`/api/planning/plans/${planId}/pending-facts`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['plan-pending-facts', planId] });
    void qc.invalidateQueries({ queryKey: ['client-facts', clientId] });
    void qc.invalidateQueries({ queryKey: ['client-fact-versions', clientId] });
  };

  const dismiss = useMutation({
    mutationFn: (factId: string) =>
      api(`/api/planning/plans/${planId}/pending-facts/${factId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const promote = useMutation({
    mutationFn: () =>
      api<{ promoted: number }>(`/api/planning/plans/${planId}/pending-facts/promote`, {
        method: 'POST',
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: () => setError('Promote failed — check that pending values fit the fact schema.'),
  });

  const facts = data?.facts ?? [];
  if (facts.length === 0) return null;

  return (
    <div className="border border-ink/10 rounded p-4 bg-white mt-6 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display text-lg">Pending facts from research</h3>
        <button
          onClick={() => promote.mutate()}
          disabled={promote.isPending}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {promote.isPending ? 'Promoting…' : `Promote ${facts.length} to client`}
        </button>
      </div>
      {error && <div className="text-oxblood text-sm mb-2">{error}</div>}
      <ul className="space-y-1.5">
        {facts.map((f) => (
          <li key={f.id} className="text-sm flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {f.text}
              <span className="text-xs text-ink/40 ml-2">
                {f.fact_path ? `→ ${f.fact_path}` : '→ open question'}
                {f.source ? ` · p.${f.source.page}` : ''}
              </span>
            </div>
            <button
              onClick={() => dismiss.mutate(f.id)}
              className="text-xs text-oxblood underline shrink-0"
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
