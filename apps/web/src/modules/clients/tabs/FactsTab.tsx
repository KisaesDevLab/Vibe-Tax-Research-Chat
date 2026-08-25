// TP-3a — the client Facts tab: current pattern by section with provenance
// badges, pending-candidates banner, inline section editing (change summary
// required, optimistic concurrency via base_version), version history +
// diff + restore.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { emptyFactPattern } from '@vibe/shared';
import type { ClientDTO, ClientFactPatternDTO, FactPattern } from '@vibe/shared';
import { api, ApiError } from '../../../lib/api';
import { FactSections } from '../facts/FactSections';
import { FactsVersionHistory } from '../facts/FactsVersionHistory';
import { CandidateReview } from '../facts/CandidateReview';

export function FactsTab({ client }: { client: ClientDTO }) {
  const qc = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [showCandidates, setShowCandidates] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ fact_pattern: ClientFactPatternDTO | null }>({
    queryKey: ['client-facts', client.id],
    queryFn: () => api(`/api/clients/${client.id}/facts`),
  });

  const { data: candidatesData } = useQuery<{ candidates: unknown[] }>({
    queryKey: ['client-fact-candidates', client.id],
    queryFn: () => api(`/api/clients/${client.id}/facts/candidates`),
  });

  const save = useMutation({
    mutationFn: (args: { facts: FactPattern; change_summary: string; base_version: number }) =>
      api(`/api/clients/${client.id}/facts`, { method: 'POST', body: JSON.stringify(args) }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['client-facts', client.id] });
      void qc.invalidateQueries({ queryKey: ['client-fact-versions', client.id] });
    },
  });

  if (isLoading) return <div className="text-ink/50">Loading…</div>;
  const pattern = data?.fact_pattern ?? null;
  const pendingCount = candidatesData?.candidates?.length ?? 0;

  async function handleSave(next: FactPattern, sectionTitle: string) {
    const summary = window.prompt(
      `Change summary for the ${sectionTitle} edit (required):`,
      `Edited ${sectionTitle.toLowerCase()}`,
    );
    if (!summary?.trim()) throw new Error('summary_required');
    try {
      await save.mutateAsync({
        facts: next,
        change_summary: summary.trim(),
        base_version: pattern?.version ?? 0,
      });
    } catch (err) {
      if (err instanceof ApiError && err.message === 'version_conflict') {
        setError(
          'Someone else updated this fact pattern — reload the page and re-apply your edit.',
        );
      } else if (err instanceof ApiError && err.message === 'invalid_facts') {
        setError('The edit does not fit the fact schema — check field formats (dates, codes).');
      } else {
        setError('Save failed — try again.');
      }
      throw err;
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-ink/60">
          {pattern ? (
            <>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink/10 text-ink/60 mr-2">
                v{pattern.version} · schema {pattern.schema_version}
              </span>
              {pattern.change_summary}
            </>
          ) : (
            'No fact pattern yet — accept extracted candidates or edit a section to create v1.'
          )}
        </div>
        {pattern && (
          <button
            onClick={() => setShowHistory((s) => !s)}
            className="px-2 py-1 border border-ink/20 rounded text-xs hover:bg-ink/5 shrink-0"
          >
            {showHistory ? 'Hide history' : 'History'}
          </button>
        )}
      </div>

      {error && <div className="text-oxblood text-sm">{error}</div>}

      {pendingCount > 0 && (
        <div className="border border-moss/50 rounded p-3 bg-moss/5">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <span className="font-medium">{pendingCount}</span> extracted fact
              {pendingCount === 1 ? '' : 's'} awaiting review.
            </div>
            <button
              onClick={() => setShowCandidates((s) => !s)}
              className="px-2 py-1 border border-moss/50 text-moss rounded text-xs"
            >
              {showCandidates ? 'Hide' : 'Review'}
            </button>
          </div>
          {showCandidates && (
            <div className="mt-3">
              <CandidateReview clientId={client.id} onDone={() => setShowCandidates(false)} />
            </div>
          )}
        </div>
      )}

      {showHistory && pattern && <FactsVersionHistory clientId={client.id} current={pattern} />}

      <FactSections
        clientId={client.id}
        facts={pattern?.facts ?? emptyFactPattern()}
        disabled={save.isPending}
        onSave={handleSave}
      />
    </div>
  );
}
