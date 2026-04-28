// Phase 11 — heuristic routing table. Hard cap of 8 attached skills,
// always including cpa-pack-index (dispatcher) and compliance-ssts-circular230.
//
// Inputs:
//   message    — the user's prompt text.
//   available  — the pool of skills the appliance can attach (after Phase 7 ingest).
//   custom     — any firm-authored custom skills (Phase 21).
//
// Output: ordered list of up to 8 skill slugs.

const ALWAYS_ATTACHED = ['cpa-pack-index', 'compliance-ssts-circular230'] as const;
const MAX_SKILLS = 8;

const STATE_CODES: Record<string, string> = {
  CA: 'state-ca',
  NY: 'state-ny',
  TX: 'state-tx',
  FL: 'state-fl',
  IL: 'state-il',
  PA: 'state-pa',
  OH: 'state-oh',
  NJ: 'state-nj',
  GA: 'state-ga',
  NC: 'state-nc',
};

interface RoutingRule {
  match: RegExp;
  skill: string;
  weight: number;
}

const RULES: RoutingRule[] = [
  // IRC sections
  { match: /\b(IRC|26 U\.?S\.?C\.?)\s*§?\s*(199A)\b/i, skill: 'irc-199a-qbi', weight: 9 },
  { match: /\bsection\s+199A\b/i, skill: 'irc-199a-qbi', weight: 9 },
  { match: /\b(IRC|26 U\.?S\.?C\.?)\s*§?\s*(174)\b/i, skill: 'irc-174-rd', weight: 9 },
  { match: /\b(IRC|26 U\.?S\.?C\.?)\s*§?\s*(163\(j\))/i, skill: 'irc-163j-interest', weight: 9 },
  { match: /\b(IRC|26 U\.?S\.?C\.?)\s*§?\s*(280E)\b/i, skill: 'irc-280e-cannabis', weight: 9 },
  { match: /\b(IRC|26 U\.?S\.?C\.?)\s*§?\s*(1031)\b/i, skill: 'irc-1031-like-kind', weight: 9 },

  // Form numbers
  { match: /\bform\s+1040\b/i, skill: 'form-1040-individual', weight: 7 },
  { match: /\bform\s+1120(?:-S)?\b/i, skill: 'form-1120s-scorp', weight: 7 },
  { match: /\bform\s+1065\b/i, skill: 'form-1065-partnership', weight: 7 },
  { match: /\bform\s+990\b/i, skill: 'form-990-exempt', weight: 7 },
  { match: /\bform\s+706\b/i, skill: 'form-706-estate', weight: 7 },
  { match: /\bform\s+709\b/i, skill: 'form-709-gift', weight: 7 },
  { match: /\bform\s+(8275|8275-R|8886)\b/i, skill: 'compliance-disclosure-forms', weight: 8 },

  // IRS notices / letters (CP-2000 has 4 digits; CP-14, CP-503 etc are shorter)
  { match: /\b(CP|LT)[- ]?\d{2,4}\b/i, skill: 'irs-notice-decoder', weight: 8 },
  { match: /\bnotice\s+\d{4}-\d{1,3}\b/i, skill: 'irs-notice-decoder', weight: 8 },

  // Predict / qualify / classify keywords
  { match: /\b(qualif(?:y|ies|ied|ication)|predict|classify)\b/i, skill: 'classification-predictor', weight: 5 },

  // Penalties / interest
  { match: /\b(penalty|penalt(?:ies)|abatement|first-time)\b/i, skill: 'penalty-abatement', weight: 6 },
  { match: /\b(interest\s+computation|underpayment\s+interest)\b/i, skill: 'interest-computation', weight: 6 },

  // Due dates
  { match: /\b(due\s+date|extension|deadline|automatic\s+extension)\b/i, skill: 'due-date-calculator', weight: 5 },

  // Treasury Regs
  { match: /\bTreas(?:ury)?\.?\s*Reg(?:ulation)?s?\.?\s*§?\s*1\./i, skill: 'treas-regs-lookup', weight: 7 },

  // Tax Court / DAWSON
  { match: /\bTax\s+Court\b/i, skill: 'tax-court-research', weight: 7 },
  { match: /\bDAWSON\b/i, skill: 'tax-court-research', weight: 7 },

  // Chevron / Loper Bright
  { match: /\b(Chevron|Loper\s+Bright|Skidmore)\b/i, skill: 'admin-deference-doctrine', weight: 6 },
];

export interface RouteContext {
  message: string;
  available: Array<{ local_slug: string; routing_keywords?: string[] }>;
  custom?: Array<{ local_slug: string; routing_keywords?: string[] }>;
  fallback_classifier?: (msg: string) => Promise<string[]>;
}

export interface RouteResult {
  slugs: string[];
  reasons: Record<string, string>;
  truncated: boolean;
}

export function selectSkills(ctx: RouteContext): RouteResult {
  const reasons: Record<string, string> = {};
  const score = new Map<string, number>();

  // 1. Always-attached
  for (const slug of ALWAYS_ATTACHED) {
    score.set(slug, 1000);
    reasons[slug] = 'always-attached';
  }

  // 2. Rule matches against message text
  for (const rule of RULES) {
    if (rule.match.test(ctx.message)) {
      score.set(rule.skill, (score.get(rule.skill) ?? 0) + rule.weight);
      reasons[rule.skill] = reasons[rule.skill] ?? `matched ${rule.match.source}`;
    }
  }

  // 3. State codes — match a leading state abbreviation, "California", etc.
  for (const [code, slug] of Object.entries(STATE_CODES)) {
    const re = new RegExp(`\\b${code}\\b|\\b${stateName(code)}\\b`, 'i');
    if (re.test(ctx.message)) {
      score.set(slug, (score.get(slug) ?? 0) + 8);
      reasons[slug] = `state hit: ${code}`;
    }
  }

  // 4. Custom-skill routing keywords
  for (const cs of ctx.custom ?? []) {
    for (const kw of cs.routing_keywords ?? []) {
      if (new RegExp(`\\b${escape(kw)}\\b`, 'i').test(ctx.message)) {
        score.set(cs.local_slug, (score.get(cs.local_slug) ?? 0) + 5);
        reasons[cs.local_slug] = `custom keyword: ${kw}`;
      }
    }
  }

  // 5. Filter to available + sort by score
  const availableSlugs = new Set([
    ...ctx.available.map((s) => s.local_slug),
    ...(ctx.custom ?? []).map((s) => s.local_slug),
  ]);
  for (const slug of ALWAYS_ATTACHED) availableSlugs.add(slug);

  const ordered = [...score.entries()]
    .filter(([slug]) => availableSlugs.has(slug))
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => slug);

  const slugs = ordered.slice(0, MAX_SKILLS);
  return {
    slugs,
    reasons: Object.fromEntries(slugs.map((s) => [s, reasons[s] ?? 'unknown'])),
    truncated: ordered.length > MAX_SKILLS,
  };
}

function stateName(code: string): string {
  const names: Record<string, string> = {
    CA: 'California',
    NY: 'New York',
    TX: 'Texas',
    FL: 'Florida',
    IL: 'Illinois',
    PA: 'Pennsylvania',
    OH: 'Ohio',
    NJ: 'New Jersey',
    GA: 'Georgia',
    NC: 'North Carolina',
  };
  return names[code] ?? code;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const SKILLS_ROUTING_CONFIG = {
  MAX_SKILLS,
  ALWAYS_ATTACHED,
  RULES_COUNT: RULES.length,
};
