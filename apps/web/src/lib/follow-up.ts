// Phase 33 — parse the "Next steps (follow-up routing)" block that every
// skill answer appends, so the chat UI can render its verbs as
// click-to-route buttons instead of forcing the user to retype them.
// Spec lives in the skills repo at shared/follow-up-routing.md.

export type FollowUpVerb =
  | 'memo'
  | 'open-point'
  | 'plan'
  | 'workpaper'
  | 'resolution'
  | 'return'
  | 'client-email'
  | 'excel-workpaper';

export type FollowUpGroup = 'package' | 'carry' | 'deliver';

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
  {
    verb: 'client-email',
    group: 'deliver',
    label: 'Client email',
    hint: 'Plain-language email summary suitable to send to a non-CPA client',
  },
  {
    verb: 'excel-workpaper',
    group: 'deliver',
    label: 'Excel workpaper',
    hint: 'Excel calculation worksheet with amounts, tickmarks, and footed totals',
  },
];

const VERB_SET = new Set<string>(FOLLOW_UP_VERBS.map((v) => v.verb));
const VERB_ORDER = new Map<FollowUpVerb, number>(FOLLOW_UP_VERBS.map((v, i) => [v.verb, i]));

const HEADING_RE = /^##\s+Next steps \(follow-up routing\)\s*$/m;
// Relaxed mode anchor — matches the model's paraphrased forms in practice
// ("**What to do next?** Reply with one of: ...", "Follow-ups:", "Next
// steps:", etc.). We require this anchor near the verb tokens so a stray
// inline mention like "see the `memo` skill above" doesn't render chips.
const RELAXED_ANCHOR_RE =
  /(?:next steps?|follow.?ups?|what to do next|reply with (?:one|any|either|a))/i;
const TAIL_WINDOW = 1500;

export interface FollowUpActions {
  verbs: FollowUpVerb[];
  conclusionEcho?: string;
}

function collectVerbs(block: string, listOnly: boolean): FollowUpVerb[] {
  const verbRe = listOnly ? /^\s*[-*]\s+`([a-z-]+)`/gm : /`([a-z-]+)`/g;
  const seen = new Set<FollowUpVerb>();
  const verbs: FollowUpVerb[] = [];
  let m: RegExpExecArray | null;
  while ((m = verbRe.exec(block)) !== null) {
    const tok = m[1]!;
    if (VERB_SET.has(tok) && !seen.has(tok as FollowUpVerb)) {
      seen.add(tok as FollowUpVerb);
      verbs.push(tok as FollowUpVerb);
    }
  }
  verbs.sort((a, b) => (VERB_ORDER.get(a) ?? 0) - (VERB_ORDER.get(b) ?? 0));
  return verbs;
}

export function extractFollowUpActions(markdown: string): FollowUpActions | null {
  // Tier 1: canonical spec block. Heading + list-item backticked verbs.
  const headingMatch = HEADING_RE.exec(markdown);
  if (headingMatch) {
    const tail = markdown.slice(headingMatch.index + headingMatch[0].length);
    const nextHeading = /\n#{1,2}\s+\S/.exec(tail);
    const block = nextHeading ? tail.slice(0, nextHeading.index) : tail;
    const verbs = collectVerbs(block, true);
    if (verbs.length > 0) {
      const echoMatch = /^Conclusion echo:\s*(.+?)\s*$/m.exec(block);
      const conclusionEcho = echoMatch && !/^<.*>$/.test(echoMatch[1]!) ? echoMatch[1] : undefined;
      return { verbs, conclusionEcho };
    }
  }

  // Tier 2: relaxed — the model often paraphrases the spec into a single
  // sentence at the very end of the answer. Search the trailing window for
  // a follow-up anchor; if present, scan from there for any backticked
  // verbs (not just list items, since the paraphrase form is inline).
  const tail = markdown.slice(-TAIL_WINDOW);
  const anchor = RELAXED_ANCHOR_RE.exec(tail);
  if (!anchor) return null;
  const fromAnchor = tail.slice(anchor.index);
  const verbs = collectVerbs(fromAnchor, false);
  if (verbs.length === 0) return null;
  return { verbs };
}
