// Phase 19 — compliance disclosure panel (SSTS / Circular 230).
import type { ComplianceCheck } from '@vibe/shared';

const ROWS: Array<{ key: keyof ComplianceCheck; label: string }> = [
  { key: 'ssts_1_1', label: 'SSTS § 1.1 — Tax return positions' },
  { key: 'ssts_2_3', label: 'SSTS § 2.3 — Estimates' },
  { key: 'circ_230_10_22', label: 'Circular 230 § 10.22 — Diligence as to accuracy' },
  { key: 'circ_230_10_35', label: 'Circular 230 § 10.35 — Competence' },
  { key: 'circ_230_10_37', label: 'Circular 230 § 10.37 — Written advice' },
];

export function CompliancePanel({ check }: { check?: ComplianceCheck }) {
  if (!check) return null;
  return (
    <section className="border border-moss/30 rounded mt-4 bg-moss/5">
      <header className="px-4 py-2 border-b border-moss/20 font-display tracking-wide text-sm text-moss">
        Compliance Check
      </header>
      <ul className="divide-y divide-moss/10 text-sm">
        {ROWS.map(({ key, label }) => {
          const v = check[key] as { ok: boolean; note?: string } | undefined;
          if (!v) return null;
          return (
            <li key={key} className="px-4 py-2 flex items-start gap-3">
              <span className={`mt-0.5 text-xs font-mono ${v.ok ? 'text-moss' : 'text-oxblood'}`}>
                {v.ok ? '✓' : '⚠'}
              </span>
              <div className="flex-1">
                <div>{label}</div>
                {v.note && <div className="text-xs text-ink/60 mt-0.5">{v.note}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {check.form_disclosure_required && check.form_disclosure_required.length > 0 && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs">
          <span className="font-mono">Disclosure forms required: </span>
          {check.form_disclosure_required.map((f) => (
            <span key={f} className="compliance-chip mr-1">Form {f}</span>
          ))}
        </div>
      )}
      {check.loper_bright_caveat && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs text-ink/60">
          Post-Loper Bright: cited Treasury Regulations carry only Skidmore weight.
        </div>
      )}
    </section>
  );
}
