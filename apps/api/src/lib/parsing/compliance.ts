// Phase 19 — extract compliance check from compliance-ssts-circular230 skill output.
//
// Same matrix of shapes as authorities.ts — the model doesn't always wrap
// the payload in the `compliance` tagged fence the spec asks for. We try
// every shape in order so the CompliancePanel always has data to render.
import type { ComplianceCheck } from '@vibe/shared';
import { logger } from '../logger.js';

const TAGGED_FENCE_RE = /```(?:json|jsonc)?\s*compliance\s*\n([\s\S]*?)(?:```|$)/i;
const JSON_FENCE_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)(?:```|$)/gi;
const BARE_OBJECT_RE =
  /(?:^|\n\s*\n)\s*(\{[\s\S]*?"(?:compliance|compliance_check|ssts_1_1|circ230_10_22|circ_230_10_22)"\s*:[\s\S]*?\})\s*(?=\n\s*\n|\s*$)/m;

// The model sometimes wraps the actual check under a `compliance` /
// `compliance_check` key, sometimes emits the rule object directly.
function unwrap(v: unknown): ComplianceCheck | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (obj.compliance && typeof obj.compliance === 'object') {
    return obj.compliance as ComplianceCheck;
  }
  if (obj.compliance_check && typeof obj.compliance_check === 'object') {
    return obj.compliance_check as ComplianceCheck;
  }
  // Heuristic: if it has any of the known compliance keys, treat as flat.
  const keys = [
    'ssts_1_1',
    'ssts_2_3',
    'circ230_10_22',
    'circ_230_10_22',
    'circ230_10_35',
    'circ_230_10_35',
    'circ230_10_37',
    'circ_230_10_37',
    'engagement_type',
    'disclosure_forms',
  ];
  if (keys.some((k) => k in obj)) return obj as ComplianceCheck;
  return null;
}

function tryParse(json: string): ComplianceCheck | null {
  try {
    return unwrap(JSON.parse(json));
  } catch {
    return null;
  }
}

export function extractCompliance(text: string): ComplianceCheck | undefined {
  const tagged = text.match(TAGGED_FENCE_RE);
  if (tagged) {
    const out = tryParse(tagged[1]!.trim());
    if (out) return out;
  }

  for (const m of text.matchAll(JSON_FENCE_RE)) {
    const body = m[1] ?? '';
    if (!/(?:"compliance(_check)?"\s*:)|(?:"ssts_|"circ_?230_|"engagement_type")/i.test(body))
      continue;
    const out = tryParse(body.trim());
    if (out) return out;
  }

  const bare = text.match(BARE_OBJECT_RE);
  if (bare) {
    const out = tryParse(bare[1]!);
    if (out) return out;
    logger.warn({ snippet: bare[1]!.slice(0, 200) }, 'compliance bare-JSON parse failed');
  }

  return undefined;
}
