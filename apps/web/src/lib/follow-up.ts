// Phase 33 — parse the "Next steps (follow-up routing)" block that every
// skill answer appends, so the chat UI can render its verbs as
// click-to-route buttons instead of forcing the user to retype them.
// Spec lives in the skills repo at shared/follow-up-routing.md.

export type FollowUpVerb = 'memo' | 'open-point' | 'plan' | 'workpaper' | 'resolution' | 'return';

export type FollowUpGroup = 'package' | 'carry';

export interface FollowUpVerbMeta {
  verb: FollowUpVerb;
  group: FollowUpGroup;
  label: string;
  hint: string;
}

// Stable display order; mirrors the spec's two-group layout.
export const FOLLOW_UP_VERBS: readonly FollowUpVerbMeta[] = [
  {
    verb: 'memo',
    group: 'package',
    label: 'Memo',
    hint: 'Formal memorandum (issue, facts, analysis, conclusion, authorities)',
  },
  {
    verb: 'open-point',
    group: 'package',
    label: 'Open points',
    hint: 'Items still requiring client confirmation, citator review, or further research',
  },
  {
    verb: 'plan',
    group: 'carry',
    label: 'Plan',
    hint: 'Planning actions, multi-year projection, or strategy library lookup',
  },
  {
    verb: 'workpaper',
    group: 'carry',
    label: 'Workpaper',
    hint: 'Engagement-file scaffold (PBC list, tickmark legend, lead sheets, indexing)',
  },
  {
    verb: 'resolution',
    group: 'carry',
    label: 'Resolution',
    hint: 'IRS notice response, reasonable-cause request, penalty/interest, or Tax Court procedure',
  },
  {
    verb: 'return',
    group: 'carry',
    label: 'Return',
    hint: 'Return summary, line explainer, due-date calculation, or election attachment',
  },
];

const VERB_SET = new Set<string>(FOLLOW_UP_VERBS.map((v) => v.verb));
const VERB_ORDER = new Map<FollowUpVerb, number>(FOLLOW_UP_VERBS.map((v, i) => [v.verb, i]));

const HEADING_RE = /^##\s+Next steps \(follow-up routing\)\s*$/m;

export interface FollowUpActions {
  verbs: FollowUpVerb[];
  conclusionEcho?: string;
}

export function extractFollowUpActions(markdown: string): FollowUpActions | null {
  const headingMatch = HEADING_RE.exec(markdown);
  if (!headingMatch) return null;

  // Scope to the heading-onward slice; clip at the next top-level heading
  // so a later section can't bleed verbs into this one.
  const tail = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /\n#{1,2}\s+\S/.exec(tail);
  const block = nextHeading ? tail.slice(0, nextHeading.index) : tail;

  const verbs: FollowUpVerb[] = [];
  const seen = new Set<FollowUpVerb>();
  const verbRe = /^\s*[-*]\s+`([a-z-]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(block)) !== null) {
    const tok = m[1]!;
    if (VERB_SET.has(tok) && !seen.has(tok as FollowUpVerb)) {
      seen.add(tok as FollowUpVerb);
      verbs.push(tok as FollowUpVerb);
    }
  }
  if (verbs.length === 0) return null;

  verbs.sort((a, b) => (VERB_ORDER.get(a) ?? 0) - (VERB_ORDER.get(b) ?? 0));

  const echoMatch = /^Conclusion echo:\s*(.+?)\s*$/m.exec(block);
  const conclusionEcho = echoMatch && !/^<.*>$/.test(echoMatch[1]!) ? echoMatch[1] : undefined;

  return { verbs, conclusionEcho };
}
