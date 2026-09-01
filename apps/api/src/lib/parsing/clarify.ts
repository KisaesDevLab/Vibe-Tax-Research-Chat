// Question mode — extract the `clarify` sidecar the model emits while it is
// interviewing the researcher ({status:'asking', question, options?}) or
// has reached confidence ({status:'ready', summary, plan}). Same shape
// tolerance as the other sidecars: tagged fence, generic JSON fence whose
// body is a clarify-shaped object (or wraps one under a "clarify" key),
// bare object. Closing fences optional so a truncated stream still parses.
import type { Clarification } from '@vibe/shared';

const TAGGED_FENCE_RE = /```(?:json|jsonc)?\s*clarify\s*\n([\s\S]*?)(?:```|$)/i;
const JSON_FENCE_RE = /```(?:json|jsonc)?\s*\n([\s\S]*?)(?:```|$)/gi;
const BARE_OBJECT_RE =
  /(?:^|\n\s*\n)\s*(\{[\s\S]*?"(?:clarify|status)"\s*:[\s\S]*?\})\s*(?=\n\s*\n|\s*$)/m;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function strList(v: unknown, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(str).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out.slice(0, max) : undefined;
}

// The prompt asks for a 0–1 fraction; tolerate "95" / "95%" style too.
function confidence(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const m = v.match(/-?\d+(?:\.\d+)?/);
    if (m) n = Number(m[0]);
  }
  if (n === undefined || !Number.isFinite(n)) return undefined;
  if (n > 1) n = n / 100;
  return Math.min(1, Math.max(0, n));
}

function fromAny(v: unknown): Clarification | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  if (rec.clarify && typeof rec.clarify === 'object') return fromAny(rec.clarify);
  const status = str(rec.status)?.toLowerCase();
  if (status === 'asking') {
    const question = str(rec.question);
    if (!question) return null;
    const options = strList(rec.options, 5);
    return {
      status: 'asking',
      confidence: confidence(rec.confidence) ?? 0,
      question,
      ...(options ? { options } : {}),
    };
  }
  if (status === 'ready') {
    const summary = str(rec.summary) ?? str(rec.rationale);
    const plan = strList(rec.plan, 2) ?? (str(rec.plan) ? [str(rec.plan)!] : undefined);
    if (!summary && !plan) return null;
    return {
      status: 'ready',
      confidence: confidence(rec.confidence) ?? 0.95,
      ...(summary ? { summary } : {}),
      ...(plan ? { plan } : {}),
    };
  }
  return null;
}

function tryParse(json: string): Clarification | null {
  try {
    return fromAny(JSON.parse(json));
  } catch {
    return null;
  }
}

export function extractClarification(text: string): Clarification | null {
  const tagged = text.match(TAGGED_FENCE_RE);
  if (tagged) {
    const out = tryParse(tagged[1]!.trim());
    if (out) return out;
  }

  for (const m of text.matchAll(JSON_FENCE_RE)) {
    const head = m[1]!.slice(0, 200);
    if (!/"clarify"|"status"\s*:\s*"(?:asking|ready)"/i.test(head)) continue;
    const out = tryParse(m[1]!.trim());
    if (out) return out;
  }

  const bare = text.match(BARE_OBJECT_RE);
  if (bare) {
    const out = tryParse(bare[1]!);
    if (out) return out;
  }
  return null;
}
