// TP-6 — baseline profile editor. A validated JSON editor for the
// walking skeleton; TP-7 replaces this with the typed intake form + PDF
// import (this component stays as the "advanced" escape hatch).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';

export function ProfileTab({ detail }: { detail: PlanDetail }) {
  const { plan } = detail;
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => JSON.stringify(plan.baseline_profile, null, 2));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (profile: unknown) =>
      api(`/api/planning/plans/${plan.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ baseline_profile: profile }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plan', plan.id] });
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-ink/60 mb-2">
        Baseline profile (JSON). The typed intake form and 1040 PDF import arrive with the intake
        phase — this editor stays as the advanced path.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={24}
        spellCheck={false}
        className="w-full font-mono text-xs border border-ink/20 rounded p-3"
      />
      {error && <div className="text-oxblood text-sm mt-2">{error}</div>}
      <div className="flex justify-end mt-2">
        <button
          onClick={() => {
            try {
              save.mutate(JSON.parse(draft));
            } catch {
              setError('Invalid JSON');
            }
          }}
          disabled={save.isPending}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}
