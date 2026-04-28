// Phase 19 — compliance disclosure section (SSTS / Circular 230).
//
// Rendered as a document-style "Compliance" h2 section so it sits in the
// same vertical rhythm as the rest of the response. The model emits each
// rule as one of: a boolean, a free-text string ("N/A — no estimates"),
// null (rule not implicated), or a structured `{ok, note}`. We normalize
// all four to a single status + optional note shape.
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
  state: 'pass' | 'na' | 'fail';
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

function StateLabel({ state }: { state: NormalizedRule['state'] }) {
  const map = {
    pass: { text: '✓ satisfied', cls: 'text-moss' },
    fail: { text: '⚠ review', cls: 'text-oxblood' },
    na: { text: 'n/a', cls: 'text-ink/40' },
  } as const;
  const { text, cls } = map[state];
  return (
    <span className={`text-xs font-mono uppercase tracking-wider whitespace-nowrap ${cls}`}>
      {text}
    </span>
  );
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

  const renderableRules = RULES.map((row) => {
    const v = check[row.pickKey] ?? (row.altKey ? check[row.altKey] : undefined);
    const n = normalize(v as ComplianceRule | undefined);
    return n ? { row, n } : null;
  }).filter((x): x is { row: RuleRow; n: NormalizedRule } => x !== null);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 mt-8 mb-3">
        <h2 className="font-display text-xl">Compliance</h2>
        {check.confidence_band && (
          <span className="text-xs font-mono text-moss/80 whitespace-nowrap">
            {check.confidence_band}
          </span>
        )}
      </div>

      {check.engagement_type && (
        <p className="text-sm leading-relaxed text-ink/80 mb-3">
          <span className="text-xs uppercase tracking-wider text-ink/40 mr-2">Engagement</span>
          {check.engagement_type}
        </p>
      )}

      {renderableRules.length > 0 && (
        <ul className="space-y-2 mb-3">
          {renderableRules.map(({ row, n }) => (
            <li key={row.pickKey} className="leading-relaxed">
              <div className="flex items-baseline justify-between gap-3">
                <span>{row.label}</span>
                <StateLabel state={n.state} />
              </div>
              {n.note && <div className="text-xs text-ink/60 mt-0.5">{n.note}</div>}
            </li>
          ))}
        </ul>
      )}

      {meaningfulForms.length > 0 && (
        <p className="text-sm leading-relaxed mb-3">
          <span className="text-xs uppercase tracking-wider text-ink/40 mr-2">
            Disclosure forms
          </span>
          {meaningfulForms
            .map((f) => (f.toLowerCase().startsWith('form') ? f : `Form ${f}`))
            .join(', ')}
        </p>
      )}

      {(check.negative_treatment_review || check.negative_treatment_review_required) && (
        <p className="text-sm leading-relaxed text-ink/80 mb-3">
          <span className="text-xs uppercase tracking-wider text-ink/40 mr-2">
            Negative-treatment review
          </span>
          {typeof check.negative_treatment_review === 'string'
            ? check.negative_treatment_review
            : check.negative_treatment_review_required
              ? 'Required — verify cited authorities for subsequent history.'
              : 'Not required.'}
        </p>
      )}

      {check.loper_bright_caveat && (
        <p className="text-sm text-ink/70 italic mb-3">
          Post-Loper Bright: cited Treasury Regulations carry only Skidmore weight.
        </p>
      )}

      {check.notes && (
        <p className="text-sm leading-relaxed text-ink/80">
          <span className="text-xs uppercase tracking-wider text-ink/40 mr-2">Notes</span>
          {check.notes}
        </p>
      )}
    </section>
  );
}
