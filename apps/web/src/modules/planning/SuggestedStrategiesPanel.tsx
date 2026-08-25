// TP-5a — the Suggested Strategies panel: every non-excluded strategy from
// the tri-state evaluation, sorted by matched-predicate count, advisory
// included. toConfirm chips carry a "Research this" launcher that opens a
// plan-scoped chat pre-seeded with the fact to confirm (TP-8a).
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { StrategySuggestionDTO, SuggestResponse } from '@vibe/shared';
import { api } from '../../lib/api';

interface StrategyName {
  id: string;
  name: string;
  modeled: boolean;
}

export function SuggestedStrategiesPanel({
  planId,
  suggestData,
  strategies,
}: {
  planId: string;
  suggestData: SuggestResponse | undefined;
  strategies: StrategyName[];
}) {
  const navigate = useNavigate();
  const [showExcluded, setShowExcluded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const research = useMutation({
    mutationFn: (args: { strategy_id: string; question: string }) =>
      api<{ chat_id: string }>(`/api/planning/plans/${planId}/chat`, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    onSuccess: (data) => navigate(`/research/${data.chat_id}`),
    onError: () => setError('Could not open a research chat — try again.'),
  });

  if (!suggestData) return null;
  const names = new Map(strategies.map((s) => [s.id, s]));
  const hasSnapshot = suggestData.has_fact_snapshot;

  const visible = suggestData.suggestions
    .filter((s) => s.status !== 'excluded')
    .sort(
      (a, b) => b.matched.length - a.matched.length || a.strategyId.localeCompare(b.strategyId),
    );
  const excluded = suggestData.suggestions.filter((s) => s.status === 'excluded');

  if (visible.length === 0 && excluded.length === 0) return null;

  function chips(s: StrategySuggestionDTO) {
    return (
      <div className="flex flex-wrap gap-1 mt-1">
        {s.matched.map((m, i) => (
          <span key={`m${i}`} className="text-[10px] px-1.5 py-0.5 rounded bg-moss/15 text-moss">
            {m}
          </span>
        ))}
        {hasSnapshot &&
          s.toConfirm.map((m, i) => (
            <span
              key={`c${i}`}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-gold/60 text-gold"
            >
              {m}
              <button
                onClick={() =>
                  research.mutate({
                    strategy_id: s.strategyId,
                    question: `Confirm for this plan: ${m}. Ground the answer in the client's documents and cite pages.`,
                  })
                }
                disabled={research.isPending}
                className="underline underline-offset-2 disabled:opacity-50"
                title="Open a document-grounded research chat for this fact"
              >
                Research this
              </button>
            </span>
          ))}
      </div>
    );
  }

  return (
    <div className="border border-ink/10 rounded p-4 bg-white mb-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-display text-lg">Suggested strategies</h3>
        {excluded.length > 0 && (
          <button
            onClick={() => setShowExcluded((v) => !v)}
            className="text-xs text-ink/40 underline underline-offset-2"
          >
            {showExcluded ? 'hide' : 'show'} {excluded.length} excluded
          </button>
        )}
      </div>
      {!hasSnapshot && (
        <div className="text-xs text-ink/50 mb-2">
          No fact pattern on file — upload documents or add facts on the client's Facts tab to
          sharpen suggestions.
        </div>
      )}
      {error && <div className="text-oxblood text-sm mb-2">{error}</div>}
      {visible.length === 0 ? (
        <div className="text-ink/40 text-sm">Nothing suggested for this profile yet.</div>
      ) : (
        <ul className="space-y-2">
          {visible.map((s) => {
            const meta = names.get(s.strategyId);
            return (
              <li key={s.strategyId} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{meta?.name ?? s.strategyId}</span>
                  {meta && !meta.modeled && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10 text-ink/50">
                      advisory
                    </span>
                  )}
                  <span
                    className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      s.status === 'matched'
                        ? 'bg-gold/20 text-ink/70'
                        : 'border border-gold/60 text-gold'
                    }`}
                  >
                    {s.status === 'matched' ? 'suggested' : 'confirm facts'}
                  </span>
                </div>
                {s.reason && <div className="text-xs text-ink/50">{s.reason}</div>}
                {chips(s)}
              </li>
            );
          })}
        </ul>
      )}
      {showExcluded && excluded.length > 0 && (
        <ul className="mt-3 pt-2 border-t border-ink/10 space-y-1">
          {excluded.map((s) => (
            <li key={s.strategyId} className="text-xs text-ink/40">
              {names.get(s.strategyId)?.name ?? s.strategyId} — {s.excluded.join('; ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
