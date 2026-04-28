// Phase 19 — compliance disclosure panel (SSTS / Circular 230).
//
// The model emits each rule as one of: a boolean (passed/failed), a string
// (free-text "N/A — no estimates involved"), null (rule not implicated),
// or a structured `{ok, note}`. We normalize all four to a render-friendly
// shape so the panel never shows raw JSON.
import type { ComplianceCheck, ComplianceRule } from '@vibe/shared';

interface RuleRow {
  pickKey: keyof ComplianceCheck;
  altKey?: keyof ComplianceCheck;
  label: string;
}

const RULES: RuleRow[] = [
  { pickKey: 'ssts_1_1', label: 'SSTS § 1.1 — Tax return positions' },
  { pickKey: 'ssts_2_3', label: 'SSTS § 2.3 — Estimates' },
  {
    pickKey: 'circ230_10_22',
    altKey: 'circ_230_10_22',
    label: 'Circular 230 § 10.22 — Diligence as to accuracy',
  },
  {
    pickKey: 'circ230_10_35',
    altKey: 'circ_230_10_35',
    label: 'Circular 230 § 10.35 — Competence',
  },
  {
    pickKey: 'circ230_10_37',
    altKey: 'circ_230_10_37',
    label: 'Circular 230 § 10.37 — Written advice',
  },
];

interface NormalizedRule {
  state: 'pass' | 'warn' | 'na' | 'fail';
  note?: string;
}

function normalize(v: ComplianceRule | undefined): NormalizedRule | null {
  if (v === undefined) return null;
  if (v === null) return { state: 'na', note: 'Not implicated by this turn' };
  if (typeof v === 'boolean') return { state: v ? 'pass' : 'fail' };
  if (typeof v === 'string') {
    const lower = v.toLowerCase();
    if (lower.startsWith('n/a')) return { state: 'na', note: v };
    return { state: 'pass', note: v };
  }
  if (typeof v === 'object') {
    return { state: v.ok ? 'pass' : 'fail', note: v.note };
  }
  return null;
}

function StateGlyph({ state }: { state: NormalizedRule['state'] }) {
  switch (state) {
    case 'pass':
      return <span className="text-moss font-mono text-xs">✓</span>;
    case 'fail':
      return <span className="text-oxblood font-mono text-xs">⚠</span>;
    case 'warn':
      return <span className="text-gold font-mono text-xs">⚠</span>;
    case 'na':
      return <span className="text-ink/40 font-mono text-xs">—</span>;
  }
}

export function CompliancePanel({ check }: { check?: ComplianceCheck | null }) {
  if (!check) return null;

  const disclosures =
    check.disclosure_forms && check.disclosure_forms.length
      ? check.disclosure_forms
      : (check.form_disclosure_required ?? []);
  const meaningfulForms = disclosures.filter(
    (f) => f && f.toLowerCase() !== 'none' && f.toLowerCase() !== 'n/a',
  );

  return (
    <section className="border border-moss/30 rounded bg-moss/5">
      <header className="px-4 py-2 border-b border-moss/20 font-display tracking-wide text-sm text-moss flex items-center justify-between">
        <span>Compliance Check</span>
        {check.confidence_band && (
          <span className="text-xs font-mono text-moss/70">{check.confidence_band}</span>
        )}
      </header>

      {check.engagement_type && (
        <div className="px-4 py-2 border-b border-moss/10 text-xs text-ink/70">
          <span className="uppercase tracking-wider text-ink/40 mr-2">engagement</span>
          {check.engagement_type}
        </div>
      )}

      <ul className="divide-y divide-moss/10 text-sm">
        {RULES.map((row) => {
          const v = check[row.pickKey] ?? (row.altKey ? check[row.altKey] : undefined);
          const n = normalize(v as ComplianceRule | undefined);
          if (!n) return null;
          return (
            <li key={row.pickKey} className="px-4 py-2 flex items-start gap-3">
              <StateGlyph state={n.state} />
              <div className="flex-1">
                <div>{row.label}</div>
                {n.note && <div className="text-xs text-ink/60 mt-0.5">{n.note}</div>}
              </div>
            </li>
          );
        })}
      </ul>

      {meaningfulForms.length > 0 && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs">
          <span className="font-mono uppercase tracking-wider text-ink/40 mr-2">
            disclosure forms
          </span>
          {meaningfulForms.map((f) => (
            <span
              key={f}
              className="inline-block px-2 py-0.5 mr-1 rounded border border-oxblood/30 bg-oxblood/5 text-oxblood font-mono"
            >
              {f.startsWith('Form') ? f : `Form ${f}`}
            </span>
          ))}
        </div>
      )}

      {(check.negative_treatment_review || check.negative_treatment_review_required) && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs text-ink/60">
          <span className="uppercase tracking-wider text-ink/40 mr-2">
            negative-treatment review
          </span>
          {typeof check.negative_treatment_review === 'string'
            ? check.negative_treatment_review
            : check.negative_treatment_review_required
              ? 'Required — verify cited authorities for subsequent history.'
              : 'Not required.'}
        </div>
      )}

      {check.loper_bright_caveat && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs text-ink/60">
          Post-Loper Bright: cited Treasury Regulations carry only Skidmore weight.
        </div>
      )}

      {check.notes && (
        <div className="px-4 py-2 border-t border-moss/20 text-xs text-ink/70">
          <span className="uppercase tracking-wider text-ink/40 mr-2">notes</span>
          {check.notes}
        </div>
      )}
    </section>
  );
}
