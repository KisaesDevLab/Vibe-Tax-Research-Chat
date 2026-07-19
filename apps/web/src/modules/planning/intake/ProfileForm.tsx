// TP-7 — typed baseline-profile editor. Staff-facing: every number the
// engine consumes, editable in place, saved via the plans PATCH.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BaselineProfile, BusinessProfile, RentalProfile } from '@vibe/shared';
import { api } from '../../../lib/api';

export function ProfileForm({
  planId,
  initial,
  frozen,
}: {
  planId: string;
  initial: BaselineProfile;
  frozen: boolean;
}) {
  const qc = useQueryClient();
  const [p, setP] = useState<BaselineProfile>(initial);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/planning/plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ baseline_profile: p }),
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plan', planId] });
    },
    onError: (err) => setError((err as Error).message),
  });

  const num = (v: string) => (v === '' ? 0 : Number(v));
  const set = (patch: Partial<BaselineProfile>) => setP({ ...p, ...patch });

  const numField = (label: string, value: number, onChange: (n: number) => void) => (
    <label className="block text-sm">
      <span className="text-ink/60">{label}</span>
      <input
        type="number"
        value={value === 0 ? '' : value}
        placeholder="0"
        disabled={frozen}
        onChange={(e) => onChange(num(e.target.value))}
        className="mt-0.5 w-full px-2 py-1.5 border border-ink/20 rounded text-sm"
      />
    </label>
  );

  return (
    <div className="max-w-3xl space-y-5">
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label className="block text-sm">
          <span className="text-ink/60">Filing status</span>
          <select
            value={p.filingStatus}
            disabled={frozen}
            onChange={(e) =>
              set({ filingStatus: e.target.value as BaselineProfile['filingStatus'] })
            }
            className="mt-0.5 w-full px-2 py-1.5 border border-ink/20 rounded text-sm bg-white"
          >
            <option value="single">Single</option>
            <option value="mfj">Married filing jointly</option>
            <option value="mfs">Married filing separately</option>
            <option value="hoh">Head of household</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-ink/60">State code</span>
          <input
            value={p.state?.code ?? ''}
            placeholder="none"
            disabled={frozen}
            onChange={(e) =>
              set({
                state: e.target.value
                  ? { code: e.target.value.toUpperCase(), flatRate: p.state?.flatRate ?? 0 }
                  : null,
              })
            }
            className="mt-0.5 w-full px-2 py-1.5 border border-ink/20 rounded text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-ink/60">State flat rate (%)</span>
          <input
            type="number"
            step="0.1"
            value={p.state ? p.state.flatRate * 100 : ''}
            disabled={frozen || !p.state}
            onChange={(e) =>
              set({ state: p.state ? { ...p.state, flatRate: num(e.target.value) / 100 } : null })
            }
            className="mt-0.5 w-full px-2 py-1.5 border border-ink/20 rounded text-sm"
          />
        </label>
        {numField('W-2 wages (household)', p.wages, (v) => set({ wages: v }))}
      </section>

      <BusinessesEditor
        businesses={p.businesses}
        frozen={frozen}
        onChange={(businesses) => set({ businesses })}
      />
      <RentalsEditor rentals={p.rentals} frozen={frozen} onChange={(rentals) => set({ rentals })} />

      <section>
        <h3 className="font-display text-lg mb-2">Investment & other income</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {numField('Taxable interest', p.interestIncome, (v) => set({ interestIncome: v }))}
          {numField('Ordinary (non-qual.) dividends', p.ordinaryDividends, (v) =>
            set({ ordinaryDividends: v }),
          )}
          {numField('Qualified dividends', p.qualifiedDividends, (v) =>
            set({ qualifiedDividends: v }),
          )}
          {numField('Short-term capital gain', p.shortTermCapGain, (v) =>
            set({ shortTermCapGain: v }),
          )}
          {numField('Long-term capital gain', p.longTermCapGain, (v) =>
            set({ longTermCapGain: v }),
          )}
          {numField('Other income', p.otherIncome, (v) => set({ otherIncome: v }))}
        </div>
      </section>

      <section>
        <h3 className="font-display text-lg mb-2">Above the line</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {numField('SE health insurance', p.seHealthInsurance, (v) =>
            set({ seHealthInsurance: v }),
          )}
          {numField('Retirement contributions', p.retirementContributions, (v) =>
            set({ retirementContributions: v }),
          )}
          {numField('HSA contribution', p.hsaContribution, (v) => set({ hsaContribution: v }))}
        </div>
      </section>

      <section>
        <h3 className="font-display text-lg mb-2">Itemized deductions paid</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {numField('State/local taxes', p.itemized.stateLocalTaxesPaid, (v) =>
            set({ itemized: { ...p.itemized, stateLocalTaxesPaid: v } }),
          )}
          {numField('Mortgage interest', p.itemized.mortgageInterest, (v) =>
            set({ itemized: { ...p.itemized, mortgageInterest: v } }),
          )}
          {numField('Charitable', p.itemized.charitable, (v) =>
            set({ itemized: { ...p.itemized, charitable: v } }),
          )}
          {numField('Other', p.itemized.other, (v) =>
            set({ itemized: { ...p.itemized, other: v } }),
          )}
        </div>
      </section>

      <section>
        <h3 className="font-display text-lg mb-2">Household & payments</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {numField('Children under 17', p.dependentsUnder17, (v) => set({ dependentsUnder17: v }))}
          {numField('Other dependents', p.otherDependents, (v) => set({ otherDependents: v }))}
          {numField('Withholding (year 1)', p.withholding, (v) => set({ withholding: v }))}
          {numField('Estimated payments', p.estimatedPayments, (v) =>
            set({ estimatedPayments: v }),
          )}
        </div>
        <p className="text-xs text-ink/40 mt-1">
          Withholding and estimates are never parsed from the return — enter deliberately.
        </p>
      </section>

      {error && <div className="text-oxblood text-sm">{error}</div>}
      <div className="flex justify-end">
        <button
          onClick={() => save.mutate()}
          disabled={frozen || save.isPending}
          className="px-3 py-1.5 bg-ink text-paper rounded text-sm disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}

function BusinessesEditor({
  businesses,
  frozen,
  onChange,
}: {
  businesses: BusinessProfile[];
  frozen: boolean;
  onChange: (b: BusinessProfile[]) => void;
}) {
  const update = (i: number, patch: Partial<BusinessProfile>) =>
    onChange(businesses.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display text-lg">Businesses</h3>
        <button
          disabled={frozen}
          onClick={() =>
            onChange([
              ...businesses,
              {
                // randomUUID, not a length-based counter — `b${length+1}`
                // collides after a removal and duplicates React keys.
                id: crypto.randomUUID(),
                name: `Business ${businesses.length + 1}`,
                kind: 'schedule-c',
                netProfit: 0,
                employeeWages: 0,
                ownerWages: 0,
                sstb: false,
                qbiEligible: true,
              },
            ])
          }
          className="text-sm underline text-ink/60 disabled:opacity-50"
        >
          + Add
        </button>
      </div>
      {businesses.length === 0 && <div className="text-sm text-ink/40">None.</div>}
      {businesses.map((b, i) => (
        <div
          key={b.id}
          className="border border-ink/10 rounded p-3 mb-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm"
        >
          <label>
            <span className="text-ink/60 text-xs">Name</span>
            <input
              value={b.name}
              disabled={frozen}
              onChange={(e) => update(i, { name: e.target.value })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label>
            <span className="text-ink/60 text-xs">Type</span>
            <select
              value={b.kind}
              disabled={frozen}
              onChange={(e) => update(i, { kind: e.target.value as BusinessProfile['kind'] })}
              className="w-full px-2 py-1 border border-ink/20 rounded bg-white"
            >
              <option value="schedule-c">Schedule C</option>
              <option value="s-corp">S corporation</option>
              <option value="partnership">Partnership</option>
            </select>
          </label>
          <label>
            <span className="text-ink/60 text-xs">Net profit (pre-owner-wage)</span>
            <input
              type="number"
              value={b.netProfit === 0 ? '' : b.netProfit}
              placeholder="0"
              disabled={frozen}
              onChange={(e) => update(i, { netProfit: Number(e.target.value || 0) })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label>
            <span className="text-ink/60 text-xs">Owner W-2 wages</span>
            <input
              type="number"
              value={b.ownerWages === 0 ? '' : b.ownerWages}
              placeholder="0"
              disabled={frozen || b.kind === 'schedule-c'}
              onChange={(e) => update(i, { ownerWages: Number(e.target.value || 0) })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label>
            <span className="text-ink/60 text-xs">Employee W-2 wages</span>
            <input
              type="number"
              value={b.employeeWages === 0 ? '' : b.employeeWages}
              placeholder="0"
              disabled={frozen}
              onChange={(e) => update(i, { employeeWages: Number(e.target.value || 0) })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label className="flex items-end gap-1 pb-1">
            <input
              type="checkbox"
              checked={b.sstb}
              disabled={frozen}
              onChange={(e) => update(i, { sstb: e.target.checked })}
            />
            <span className="text-xs text-ink/60">SSTB</span>
          </label>
          <label className="flex items-end gap-1 pb-1">
            <input
              type="checkbox"
              checked={b.qbiEligible}
              disabled={frozen}
              onChange={(e) => update(i, { qbiEligible: e.target.checked })}
            />
            <span className="text-xs text-ink/60">QBI-eligible</span>
          </label>
          <button
            disabled={frozen}
            onClick={() => onChange(businesses.filter((_, j) => j !== i))}
            className="text-xs text-oxblood underline text-left self-end pb-1"
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

function RentalsEditor({
  rentals,
  frozen,
  onChange,
}: {
  rentals: RentalProfile[];
  frozen: boolean;
  onChange: (r: RentalProfile[]) => void;
}) {
  const update = (i: number, patch: Partial<RentalProfile>) =>
    onChange(rentals.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display text-lg">Rentals</h3>
        <button
          disabled={frozen}
          onClick={() =>
            onChange([
              ...rentals,
              {
                id: crypto.randomUUID(),
                name: `Rental ${rentals.length + 1}`,
                netIncome: 0,
                activeParticipant: true,
              },
            ])
          }
          className="text-sm underline text-ink/60 disabled:opacity-50"
        >
          + Add
        </button>
      </div>
      {rentals.length === 0 && <div className="text-sm text-ink/40">None.</div>}
      {rentals.map((r, i) => (
        <div
          key={r.id}
          className="border border-ink/10 rounded p-3 mb-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-sm"
        >
          <label>
            <span className="text-ink/60 text-xs">Name</span>
            <input
              value={r.name}
              disabled={frozen}
              onChange={(e) => update(i, { name: e.target.value })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label>
            <span className="text-ink/60 text-xs">Net income (− = loss)</span>
            <input
              type="number"
              value={r.netIncome === 0 ? '' : r.netIncome}
              placeholder="0"
              disabled={frozen}
              onChange={(e) => update(i, { netIncome: Number(e.target.value || 0) })}
              className="w-full px-2 py-1 border border-ink/20 rounded"
            />
          </label>
          <label className="flex items-end gap-1 pb-1">
            <input
              type="checkbox"
              checked={r.activeParticipant}
              disabled={frozen}
              onChange={(e) => update(i, { activeParticipant: e.target.checked })}
            />
            <span className="text-xs text-ink/60">Active participant</span>
          </label>
          <button
            disabled={frozen}
            onClick={() => onChange(rentals.filter((_, j) => j !== i))}
            className="text-xs text-oxblood underline text-left self-end pb-1"
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}
