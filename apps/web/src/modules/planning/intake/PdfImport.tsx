// TP-7 — 1040 tie-out review (Numbers). TP-6a moved the upload up into
// IntakeReview (which persists the document + runs full ingest); this
// component receives the anchor parse as a prop and its confirm path is
// byte-for-byte the TP-7 flow.
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BaselineProfile } from '@vibe/shared';
import { api } from '../../../lib/api';

export interface IntakeField {
  field: string;
  value: number;
  source: string;
}
export interface IntakeResult {
  vendor: string;
  fields: IntakeField[];
  filingStatus: BaselineProfile['filingStatus'] | null;
  warnings: string[];
  tieOut: {
    agi: number | null;
    taxableIncome: number | null;
    totalTax: number | null;
    seTax: number | null;
  };
}

export function PdfImport({
  planId,
  profile,
  frozen,
  result,
  onDiscard,
}: {
  planId: string;
  profile: BaselineProfile;
  frozen: boolean;
  result: IntakeResult | null;
  onDiscard: () => void;
}) {
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAccepted(new Set((result?.fields ?? []).map((_, i) => i)));
  }, [result]);

  const confirm = useMutation({
    mutationFn: (nextProfile: BaselineProfile) =>
      api(`/api/planning/plans/${planId}/intake/confirm`, {
        method: 'POST',
        body: JSON.stringify({ baseline_profile: nextProfile }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plan', planId] });
      onDiscard();
    },
    onError: (err) => setError((err as Error).message),
  });

  function applyAccepted(): BaselineProfile {
    const next: BaselineProfile = JSON.parse(JSON.stringify(profile)) as BaselineProfile;
    if (result?.filingStatus) next.filingStatus = result.filingStatus;
    for (const [i, f] of (result?.fields ?? []).entries()) {
      if (!accepted.has(i)) continue;
      switch (f.field) {
        case 'wages':
          next.wages = f.value;
          break;
        case 'interestIncome':
          next.interestIncome = f.value;
          break;
        case 'ordinaryDividends':
          next.ordinaryDividends = f.value;
          break;
        case 'qualifiedDividends':
          next.qualifiedDividends = f.value;
          break;
        case 'shortTermCapGain':
          next.shortTermCapGain = f.value;
          break;
        case 'longTermCapGain':
          next.longTermCapGain = f.value;
          break;
        case 'business.netProfit': {
          const existing = next.businesses.find((b) => b.kind === 'schedule-c');
          if (existing) existing.netProfit = f.value;
          else
            next.businesses.push({
              id: crypto.randomUUID(),
              name: 'Schedule C business',
              kind: 'schedule-c',
              netProfit: f.value,
              employeeWages: 0,
              ownerWages: 0,
              sstb: false,
              qbiEligible: true,
            });
          break;
        }
        case 'partnership.netProfit': {
          const existing = next.businesses.find((b) => b.kind === 'partnership');
          if (existing) existing.netProfit = f.value;
          else
            next.businesses.push({
              id: crypto.randomUUID(),
              name: 'Partnership / S-corp K-1',
              kind: 'partnership',
              netProfit: f.value,
              employeeWages: 0,
              ownerWages: 0,
              sstb: false,
              qbiEligible: true,
            });
          break;
        }
        case 'rental.netIncome': {
          const existing = next.rentals[0];
          if (existing) existing.netIncome = f.value;
          else
            next.rentals.push({
              id: crypto.randomUUID(),
              name: 'Rental (from return)',
              netIncome: f.value,
              activeParticipant: true,
            });
          break;
        }
        default:
          break;
      }
    }
    return next;
  }

  return (
    <div className="max-w-3xl space-y-4">
      {error && <div className="text-oxblood text-sm">{error}</div>}
      {!result && (
        <div className="text-ink/50 text-sm">Upload a return above to see the tie-out.</div>
      )}
      {result && (
        <div className="border border-ink/10 rounded p-4 bg-white">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="font-display text-lg">Tie-out review</h3>
            <span className="text-xs text-ink/40">layout: {result.vendor}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-sm">
            {(
              [
                ['Return AGI', result.tieOut.agi],
                ['Taxable income', result.tieOut.taxableIncome],
                ['Total tax', result.tieOut.totalTax],
                ['SE tax', result.tieOut.seTax],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="border border-ink/10 rounded p-2">
                <div className="text-[10px] uppercase tracking-wider text-ink/40">{label}</div>
                <div className="font-mono">{v === null ? '—' : `$${v.toLocaleString()}`}</div>
              </div>
            ))}
          </div>

          {result.warnings.length > 0 && (
            <ul className="mb-3 text-sm text-oxblood/90 list-disc pl-5 space-y-1">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <table className="w-full text-sm mb-3">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
                <th className="py-1 w-8"></th>
                <th className="py-1 pr-3">Field</th>
                <th className="py-1 pr-3 text-right">Parsed value</th>
                <th className="py-1">Source</th>
              </tr>
            </thead>
            <tbody>
              {result.fields.map((f, i) => (
                <tr key={i} className="border-b border-ink/5">
                  <td className="py-1">
                    <input
                      type="checkbox"
                      checked={accepted.has(i)}
                      onChange={(e) => {
                        const next = new Set(accepted);
                        if (e.target.checked) next.add(i);
                        else next.delete(i);
                        setAccepted(next);
                      }}
                    />
                  </td>
                  <td className="py-1 pr-3 font-mono text-xs">{f.field}</td>
                  <td className="py-1 pr-3 text-right font-mono">${f.value.toLocaleString()}</td>
                  <td className="py-1 text-xs text-ink/40 truncate max-w-[220px]">{f.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.filingStatus && (
            <div className="text-sm text-ink/60 mb-3">
              Filing status inferred: <span className="font-medium">{result.filingStatus}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onDiscard}
              className="px-3 py-1.5 border border-ink/20 rounded text-sm"
            >
              Discard
            </button>
            <button
              onClick={() => confirm.mutate(applyAccepted())}
              disabled={frozen || confirm.isPending}
              className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
            >
              {confirm.isPending ? 'Applying…' : `Apply ${accepted.size} field(s) to profile`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
