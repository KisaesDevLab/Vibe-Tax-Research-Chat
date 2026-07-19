// TP-6 — results: baseline vs scenario totalBurden per year with deltas
// and a cumulative savings line.
import type { PlanResultDTO } from '@vibe/shared';
import type { PlanDetail } from './PlanDetailPage';

export function ScenarioCompare({ detail }: { detail: PlanDetail }) {
  const { scenarios, results } = detail;
  if (results.length === 0) {
    return (
      <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
        No computed results yet — hit Compute.
      </div>
    );
  }

  const baseline = results.filter((r) => r.scenario_id === null);
  const years = baseline.map((r) => r.year);
  const byScenario = new Map<string, PlanResultDTO[]>();
  for (const r of results) {
    if (r.scenario_id === null) continue;
    const list = byScenario.get(r.scenario_id) ?? [];
    list.push(r);
    byScenario.set(r.scenario_id, list);
  }
  const scenarioLabel = new Map(scenarios.map((s) => [s.id, s.label]));

  const money = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  return (
    <div className="max-w-4xl space-y-6">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-ink/40 border-b border-ink/10">
            <th className="py-2 pr-4">Year</th>
            <th className="py-2 pr-4 text-right">Baseline burden</th>
            {Array.from(byScenario.keys()).map((id) => (
              <th key={id} className="py-2 pr-4 text-right">
                {scenarioLabel.get(id) ?? 'Scenario'}
              </th>
            ))}
            {Array.from(byScenario.keys()).map((id) => (
              <th key={`${id}-d`} className="py-2 text-right">
                Δ {scenarioLabel.get(id) ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((year, i) => {
            const base = baseline[i]!;
            return (
              <tr key={year} className="border-b border-ink/5">
                <td className="py-2 pr-4 font-mono">{year}</td>
                <td className="py-2 pr-4 text-right font-mono">{money(base.result.totalBurden)}</td>
                {Array.from(byScenario.entries()).map(([id, rows]) => (
                  <td key={id} className="py-2 pr-4 text-right font-mono">
                    {money(rows[i]?.result.totalBurden ?? 0)}
                  </td>
                ))}
                {Array.from(byScenario.entries()).map(([id, rows]) => {
                  const delta = (rows[i]?.result.totalBurden ?? 0) - base.result.totalBurden;
                  return (
                    <td
                      key={`${id}-d`}
                      className={`py-2 text-right font-mono ${delta < 0 ? 'text-moss' : delta > 0 ? 'text-oxblood' : 'text-ink/40'}`}
                    >
                      {delta === 0 ? '—' : money(delta)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr className="font-medium">
            <td className="py-2 pr-4">Cumulative</td>
            <td className="py-2 pr-4 text-right font-mono">
              {money(baseline.reduce((a, r) => a + r.result.totalBurden, 0))}
            </td>
            {Array.from(byScenario.entries()).map(([id, rows]) => (
              <td key={id} className="py-2 pr-4 text-right font-mono">
                {money(rows.reduce((a, r) => a + r.result.totalBurden, 0))}
              </td>
            ))}
            {Array.from(byScenario.entries()).map(([id, rows]) => {
              const delta =
                rows.reduce((a, r) => a + r.result.totalBurden, 0) -
                baseline.reduce((a, r) => a + r.result.totalBurden, 0);
              return (
                <td
                  key={`${id}-d`}
                  className={`py-2 text-right font-mono ${delta < 0 ? 'text-moss' : 'text-oxblood'}`}
                >
                  {money(delta)}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
      <BurdenDetail baseline={baseline} />
    </div>
  );
}

function BurdenDetail({ baseline }: { baseline: PlanResultDTO[] }) {
  const first = baseline[0];
  if (!first) return null;
  const r = first.result;
  const rows: Array<[string, number]> = [
    ['Income tax', r.incomeTax],
    ['SE tax', r.seTax],
    ['Owner payroll tax', r.ownerPayrollTax],
    ['Additional Medicare', r.additionalMedicare],
    ['NIIT', r.niit],
    ['State tax (after PTET credit)', r.stateTax],
    ['Entity/corp tax', r.corpTaxPaid],
    ['Other taxes', r.otherTaxes],
  ];
  return (
    <section className="border border-ink/10 rounded p-4 bg-white max-w-md">
      <h2 className="font-display text-lg mb-2">Year-1 baseline burden detail</h2>
      <table className="w-full text-sm">
        <tbody>
          {rows
            .filter(([, v]) => v !== 0)
            .map(([label, v]) => (
              <tr key={label}>
                <td className="py-1 text-ink/60">{label}</td>
                <td className="py-1 text-right font-mono">
                  {v.toLocaleString('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                  })}
                </td>
              </tr>
            ))}
          <tr className="font-medium border-t border-ink/10">
            <td className="py-1">Total burden</td>
            <td className="py-1 text-right font-mono">
              {r.totalBurden.toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: 0,
              })}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
