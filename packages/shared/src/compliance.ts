// Tolerant readers for the compliance sidecar. The JSON comes from the model
// and is persisted as-is, so a field typed `string[]` can arrive as `false`,
// `"None"`, or `"8275, 8886"` — one such row blanked the whole chat page when
// the panel called `.filter` on a boolean. Every consumer (web panel, PDF,
// DOCX) reads these fields through here instead of trusting the type.

/** Render any sidecar value as display text ('' when there is nothing to show). */
export function complianceText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

const NO_FORM = new Set(['', 'none', 'n/a', 'na', 'no', 'not required']);

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.split(/[,;]/);
  return [];
}

/**
 * The disclosure forms a compliance check names, from `disclosure_forms`
 * (current) or `form_disclosure_required` (older), with "none"/"n/a"
 * placeholders dropped. Never throws on a malformed check.
 */
export function complianceDisclosureForms(check: unknown): string[] {
  if (!check || typeof check !== 'object') return [];
  const c = check as Record<string, unknown>;
  const current = asList(c.disclosure_forms);
  const raw = current.length ? current : asList(c.form_disclosure_required);
  return raw.map((f) => complianceText(f).trim()).filter((f) => !NO_FORM.has(f.toLowerCase()));
}
