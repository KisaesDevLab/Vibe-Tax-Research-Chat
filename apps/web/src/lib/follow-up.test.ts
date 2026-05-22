import { describe, expect, it } from 'vitest';
import { extractFollowUpActions } from './follow-up';

const FULL_BLOCK = `
The conclusion is that Section 199A QBI applies.

---

## Next steps (follow-up routing)

This output is a draft from \`tax-research-federal\`. Two follow-ups are
available — pick zero, one, or both:

**Package** the result as:
- \`memo\` — formal memorandum
- \`open-point\` — items still requiring client confirmation

**Carry** the conclusion forward into:
- \`plan\` — planning actions
- \`workpaper\` — workpaper scaffold
- \`resolution\` — IRS notice response
- \`return\` — return summary

Reply with one or two of the bracketed verbs.

Conclusion echo: Section 199A QBI applies to the rental real estate trade or business.
`;

const PACKAGE_ONLY = `
## Next steps (follow-up routing)

**Package** the result as:
- \`memo\` — formal memorandum
- \`open-point\` — items still pending
`;

describe('extractFollowUpActions', () => {
  it('extracts all six verbs and conclusion echo from a full block', () => {
    const r = extractFollowUpActions(FULL_BLOCK);
    expect(r).not.toBeNull();
    expect(r!.verbs).toEqual(['memo', 'open-point', 'plan', 'workpaper', 'resolution', 'return']);
    expect(r!.conclusionEcho).toContain('Section 199A QBI');
  });

  it('extracts only the verbs actually present (skill omits the carry row)', () => {
    const r = extractFollowUpActions(PACKAGE_ONLY);
    expect(r).not.toBeNull();
    expect(r!.verbs).toEqual(['memo', 'open-point']);
    expect(r!.conclusionEcho).toBeUndefined();
  });

  it('returns null when no follow-up block is present', () => {
    expect(extractFollowUpActions('# Some other content\n\nbody')).toBeNull();
  });

  it('returns null when block is present but lists no recognized verbs', () => {
    const noVerbs = `
## Next steps (follow-up routing)

This skill has no follow-ups.
`;
    expect(extractFollowUpActions(noVerbs)).toBeNull();
  });

  it('ignores backticked tokens that are not in the allowlist', () => {
    const stray = `
## Next steps (follow-up routing)

- \`memo\` — formal memorandum
- \`bogus-verb\` — should not appear
`;
    const r = extractFollowUpActions(stray);
    expect(r!.verbs).toEqual(['memo']);
  });

  it('clips at the next top-level heading so later sections do not leak in', () => {
    const withTrailingSection = `
## Next steps (follow-up routing)

- \`memo\` — formal memorandum

## Some Other Section

- \`plan\` — should be ignored
`;
    const r = extractFollowUpActions(withTrailingSection);
    expect(r!.verbs).toEqual(['memo']);
  });

  it('matches the paraphrased single-sentence form the model emits in practice', () => {
    // Real example captured from a tax-research-federal answer (gambling losses)
    // — model omits the spec heading and inlines the verbs in one sentence.
    const paraphrased = `
some long answer body...

---

**What to do next?** Reply with one of: \`memo\` (formal research memo) | \`plan\` (client planning actions) | \`return\` (carry to the 1040 return process) | \`open-point\` (log as open point) | \`workpaper\` (build a workpaper scaffold).
`;
    const r = extractFollowUpActions(paraphrased);
    expect(r).not.toBeNull();
    expect(r!.verbs).toEqual(['memo', 'open-point', 'plan', 'workpaper', 'return']);
  });

  it('matches a "Follow-ups:" anchor with inline verbs', () => {
    const inline = `
conclusion text.

Follow-ups: \`memo\`, \`open-point\`, or \`plan\`.
`;
    const r = extractFollowUpActions(inline);
    expect(r!.verbs).toEqual(['memo', 'open-point', 'plan']);
  });

  it('does NOT fire on a stray inline backticked verb without an anchor', () => {
    const stray = `
The taxpayer drafted a \`memo\` last year and we should review it.

Conclusion: position is REPORTABLE.
`;
    expect(extractFollowUpActions(stray)).toBeNull();
  });

  it('extracts the new Deliver group verbs (client-email, excel-workpaper)', () => {
    const withDeliver = `
## Next steps (follow-up routing)

**Package** the result as:
- \`memo\` — formal memorandum

**Carry** the conclusion forward into:
- \`workpaper\` — workpaper scaffold

**Deliver** the result to the client / engagement file:
- \`client-email\` — plain-language email summary
- \`excel-workpaper\` — Excel calculation worksheet
`;
    const r = extractFollowUpActions(withDeliver);
    expect(r).not.toBeNull();
    expect(r!.verbs).toEqual(['memo', 'workpaper', 'client-email', 'excel-workpaper']);
  });

  it('parses Deliver verbs inside a paraphrased single-sentence form', () => {
    const paraphrased = `
conclusion text.

**What to do next?** Reply with one of: \`memo\`, \`client-email\`, or \`excel-workpaper\`.
`;
    const r = extractFollowUpActions(paraphrased);
    expect(r).not.toBeNull();
    expect(r!.verbs).toEqual(['memo', 'client-email', 'excel-workpaper']);
  });

  it('drops the placeholder echo template that uses angle brackets', () => {
    const tmpl = `
## Next steps (follow-up routing)

- \`memo\` — formal memorandum

Conclusion echo: <one-line conclusion>
`;
    const r = extractFollowUpActions(tmpl);
    expect(r!.conclusionEcho).toBeUndefined();
  });
});
