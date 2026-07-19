// TP-7 — profile tab: typed form (default) · 1040 PDF import with
// tie-out review · raw JSON escape hatch (the TP-6 editor).
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { PlanDetail } from './PlanDetailPage';
import { ProfileForm } from './intake/ProfileForm';
import { PdfImport } from './intake/PdfImport';

const FROZEN = ['presented', 'engaged', 'delivered', 'archived'];

export function ProfileTab({ detail }: { detail: PlanDetail }) {
  const { plan } = detail;
  const frozen = FROZEN.includes(plan.status);
  const [mode, setMode] = useState<'form' | 'pdf' | 'json'>('form');

  return (
    <div>
      {frozen && (
        <div className="mb-3 text-sm text-ink/60 bg-gold/10 border border-gold/30 rounded px-3 py-2">
          This plan is {plan.status} — the profile is frozen.
        </div>
      )}
      <div className="flex gap-1 mb-4 text-sm">
        {(
          [
            ['form', 'Form'],
            ['pdf', '1040 PDF import'],
            ['json', 'JSON (advanced)'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={`px-3 py-1 rounded ${mode === key ? 'bg-ink text-paper' : 'text-ink/60 hover:bg-ink/5'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'form' && (
        <ProfileForm
          key={plan.updated_at}
          planId={plan.id}
          initial={plan.baseline_profile}
          frozen={frozen}
        />
      )}
      {mode === 'pdf' && (
        <PdfImport planId={plan.id} profile={plan.baseline_profile} frozen={frozen} />
      )}
      {mode === 'json' && <JsonEditor detail={detail} frozen={frozen} />}
    </div>
  );
}

function JsonEditor({ detail, frozen }: { detail: PlanDetail; frozen: boolean }) {
  const { plan } = detail;
  const qc = useQueryClient();
  const [draft, setDraft] = useState(() => JSON.stringify(plan.baseline_profile, null, 2));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    // Compute is disabled while this key is mutating — computing against
    // a profile PATCH still in flight would store pre-edit results.
    mutationKey: ['profile-save', plan.id],
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
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={24}
        spellCheck={false}
        disabled={frozen}
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
          disabled={frozen || save.isPending}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}
