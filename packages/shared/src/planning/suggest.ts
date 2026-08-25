// TP-5 — declarative suggest-rule evaluator. A typed JSON predicate AST
// evaluated server-side over the client profile: no eval, no runtime
// codegen (master-plan FINAL). Leaves address profile fields by dot path
// with two virtual aggregates the authoring schema relies on
// (`totalBusinessProfit`, `hasBusiness`).
//
// TP-5a adds the tri-state surface (evaluateSuggestRuleTri): leaves whose
// field starts with `facts.` resolve against the plan's fact-pattern
// snapshot and evaluate three-valued — a predicate over a MISSING fact is
// 'unknown', never false (Kleene logic through all/any/not). Profile leaves
// stay two-valued exactly as before; the legacy evaluateSuggestRule surface
// is untouched (byte-compatible) and only ever sees profile semantics.
export type SuggestOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists';

export interface SuggestLeaf {
  field: string;
  op: SuggestOp;
  value?: unknown;
  /** English rendering override for matched/toConfirm/excluded lists. */
  label?: string;
}

export interface SuggestAll {
  all: SuggestNode[];
}
export interface SuggestAny {
  any: SuggestNode[];
}
export interface SuggestNot {
  not: SuggestNode;
}

export type SuggestNode = SuggestLeaf | SuggestAll | SuggestAny | SuggestNot;

export interface SuggestRule {
  all?: SuggestNode[];
  any?: SuggestNode[];
  not?: SuggestNode;
  reason: string;
}

/** Dot-path resolution plus derived virtual fields. */
export function resolveField(profile: Record<string, unknown>, field: string): unknown {
  if (field === 'totalBusinessProfit') {
    const businesses = (profile.businesses ?? []) as Array<{ netProfit?: number }>;
    return businesses.reduce((a, b) => a + (b.netProfit ?? 0), 0);
  }
  if (field === 'hasBusiness') {
    return Array.isArray(profile.businesses) && profile.businesses.length > 0;
  }
  if (field === 'hasScheduleC') {
    const businesses = (profile.businesses ?? []) as Array<{ kind?: string }>;
    return businesses.some((b) => b.kind === 'schedule-c');
  }
  if (field === 'hasSCorp') {
    const businesses = (profile.businesses ?? []) as Array<{ kind?: string }>;
    return businesses.some((b) => b.kind === 's-corp');
  }
  if (field === 'hasEntity') {
    const businesses = (profile.businesses ?? []) as Array<{ kind?: string }>;
    return businesses.some((b) => b.kind === 's-corp' || b.kind === 'partnership');
  }
  if (field === 'hasRental') {
    return Array.isArray(profile.rentals) && (profile.rentals as unknown[]).length > 0;
  }
  if (field === 'hasEmployees') {
    const businesses = (profile.businesses ?? []) as Array<{ employeeWages?: number }>;
    return businesses.some((b) => (b.employeeWages ?? 0) > 0);
  }
  let cur: unknown = profile;
  for (const part of field.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function applyOp(actual: unknown, leaf: SuggestLeaf): boolean {
  switch (leaf.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === leaf.value;
    case 'ne':
      return actual !== leaf.value;
    case 'gt':
      return typeof actual === 'number' && actual > (leaf.value as number);
    case 'gte':
      return typeof actual === 'number' && actual >= (leaf.value as number);
    case 'lt':
      return typeof actual === 'number' && actual < (leaf.value as number);
    case 'lte':
      return typeof actual === 'number' && actual <= (leaf.value as number);
    case 'in':
      return Array.isArray(leaf.value) && (leaf.value as unknown[]).includes(actual);
    default:
      return false;
  }
}

function evalLeaf(profile: Record<string, unknown>, leaf: SuggestLeaf): boolean {
  return applyOp(resolveField(profile, leaf.field), leaf);
}

export function evaluateNode(profile: Record<string, unknown>, node: SuggestNode): boolean {
  if ('all' in node) return node.all.every((n) => evaluateNode(profile, n));
  if ('any' in node) return node.any.some((n) => evaluateNode(profile, n));
  if ('not' in node) return !evaluateNode(profile, node.not);
  return evalLeaf(profile, node);
}

export interface SuggestResult {
  matched: boolean;
  reason: string;
}

/** Interpolates `{profile.x.y}` / `{field}` templates in the reason. */
function renderReason(template: string, profile: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_m, expr: string) => {
    const field = expr.startsWith('profile.') ? expr.slice('profile.'.length) : expr;
    const v = resolveField(profile, field);
    if (typeof v === 'number') return v.toLocaleString('en-US');
    return v === undefined || v === null ? '?' : String(v);
  });
}

export function evaluateSuggestRule(
  profile: Record<string, unknown>,
  rule: SuggestRule,
): SuggestResult {
  const nodes: SuggestNode[] = [];
  if (rule.all) nodes.push({ all: rule.all });
  if (rule.any) nodes.push({ any: rule.any });
  if (rule.not) nodes.push({ not: rule.not });
  const matched = nodes.length > 0 && nodes.every((n) => evaluateNode(profile, n));
  return { matched, reason: matched ? renderReason(rule.reason, profile) : '' };
}

// ── TP-5a: tri-state facts evaluation ────────────────────────────────────

export type TriBool = boolean | 'unknown';

export interface SuggestContext {
  profile: Record<string, unknown>;
  /** FactPattern from the plan snapshot; null/undefined = no snapshot. */
  facts?: Record<string, unknown> | null;
}

export type FactResolution =
  | { kind: 'missing' } // path broken / null at any step
  | { kind: 'value'; value: unknown }
  | { kind: 'set'; values: unknown[]; anyMissing: boolean }; // ≥1 `[]` selector

const FACTS_PREFIX = 'facts.';

/**
 * Minimal JSONPath over the fact pattern: dot segments, with `[]` meaning
 * "some element" (`ownership[].relatedParty`). Distinguishes ABSENT (or
 * explicitly null — a recorded-as-unknown fact) from a PRESENT-but-empty
 * array: the former resolves toward 'unknown', the latter is a known fact
 * ("no dependents") and evaluates false, not unknown.
 */
export function resolveFactPath(facts: Record<string, unknown>, path: string): FactResolution {
  let values: unknown[] = [facts];
  let sawSelector = false;
  let anyMissing = false;
  for (const rawSeg of path.split('.')) {
    if (!rawSeg) return { kind: 'missing' };
    const isSelector = rawSeg.endsWith('[]');
    const key = isSelector ? rawSeg.slice(0, -2) : rawSeg;
    const next: unknown[] = [];
    for (const v of values) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        anyMissing = true;
        continue;
      }
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined || child === null) {
        anyMissing = true;
        continue;
      }
      if (isSelector) {
        if (!Array.isArray(child)) {
          anyMissing = true;
          continue;
        }
        sawSelector = true;
        next.push(...child);
      } else {
        next.push(child);
      }
    }
    values = next;
    // Every remaining branch dead and no selector involved → plain miss.
    if (values.length === 0 && !sawSelector) return { kind: 'missing' };
  }
  if (!sawSelector) {
    return values.length === 0 ? { kind: 'missing' } : { kind: 'value', value: values[0] };
  }
  return { kind: 'set', values, anyMissing };
}

export function kleeneNot(v: TriBool): TriBool {
  return v === 'unknown' ? 'unknown' : !v;
}

function kleeneAll(values: TriBool[]): TriBool {
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === 'unknown')) return 'unknown';
  return true;
}

function kleeneAny(values: TriBool[]): TriBool {
  if (values.some((v) => v === true)) return true;
  if (values.some((v) => v === 'unknown')) return 'unknown';
  return false;
}

export function evaluateLeafTri(ctx: SuggestContext, leaf: SuggestLeaf): TriBool {
  if (!leaf.field.startsWith(FACTS_PREFIX)) {
    // Profile leaves stay two-valued exactly as the legacy evaluator.
    return evalLeaf(ctx.profile, leaf);
  }
  if (!ctx.facts) return 'unknown';
  const res = resolveFactPath(ctx.facts, leaf.field.slice(FACTS_PREFIX.length));
  if (res.kind === 'missing') return 'unknown';
  if (res.kind === 'value') return applyOp(res.value, leaf);
  // Set: some element satisfying wins; otherwise unknown when any element
  // (or the array itself) was missing along the way; else a known false.
  if (res.values.some((v) => applyOp(v, leaf))) return true;
  // An entirely absent selector array leaves values empty AND anyMissing.
  if (res.anyMissing) return 'unknown';
  return false;
}

export function evaluateNodeTri(ctx: SuggestContext, node: SuggestNode): TriBool {
  if ('all' in node) return kleeneAll(node.all.map((n) => evaluateNodeTri(ctx, n)));
  if ('any' in node) return kleeneAny(node.any.map((n) => evaluateNodeTri(ctx, n)));
  if ('not' in node) return kleeneNot(evaluateNodeTri(ctx, node.not));
  return evaluateLeafTri(ctx, node);
}

const OP_TEXT: Record<SuggestOp, string> = {
  eq: 'is',
  ne: 'is not',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'is one of',
  exists: 'is on file',
};

/** English rendering of one predicate; `label` (author-provided) wins. */
export function describeLeaf(leaf: SuggestLeaf, negated: boolean): string {
  if (leaf.label) return leaf.label;
  const value =
    leaf.op === 'exists'
      ? ''
      : Array.isArray(leaf.value)
        ? ` ${leaf.value.map(String).join(', ')}`
        : ` ${String(leaf.value)}`;
  const base = `${leaf.field} ${OP_TEXT[leaf.op]}${value}`;
  return negated ? `not: ${base}` : base;
}

export interface SuggestEvaluation {
  status: 'matched' | 'toConfirm' | 'excluded';
  /** Rendered for matched AND toConfirm ('?' fills unknown facts). */
  reason: string;
  /** English renderings of effectively-true leaf predicates. */
  matched: string[];
  /** Leaf predicates that came out 'unknown' — facts to confirm. */
  toConfirm: string[];
  /** Effectively-false leaf predicates. */
  excluded: string[];
}

/** `{facts.x.y}` / `{profile.x}` / `{field}` interpolation over the context. */
function renderReasonTri(template: string, ctx: SuggestContext): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_m, expr: string) => {
    let v: unknown;
    if (expr.startsWith(FACTS_PREFIX)) {
      if (!ctx.facts) return '?';
      const res = resolveFactPath(ctx.facts, expr.slice(FACTS_PREFIX.length));
      v = res.kind === 'value' ? res.value : res.kind === 'set' ? res.values[0] : undefined;
    } else {
      const field = expr.startsWith('profile.') ? expr.slice('profile.'.length) : expr;
      v = resolveField(ctx.profile, field);
    }
    if (typeof v === 'number') return v.toLocaleString('en-US');
    return v === undefined || v === null ? '?' : String(v);
  });
}

export function evaluateSuggestRuleTri(ctx: SuggestContext, rule: SuggestRule): SuggestEvaluation {
  const nodes: SuggestNode[] = [];
  if (rule.all) nodes.push({ all: rule.all });
  if (rule.any) nodes.push({ any: rule.any });
  if (rule.not) nodes.push({ not: rule.not });

  const matched: string[] = [];
  const toConfirm: string[] = [];
  const excluded: string[] = [];

  // One polarity-aware walk classifying each leaf's EFFECTIVE value (an
  // odd count of enclosing `not`s flips it).
  const collect = (node: SuggestNode, negated: boolean): void => {
    if ('all' in node) {
      node.all.forEach((n) => collect(n, negated));
      return;
    }
    if ('any' in node) {
      node.any.forEach((n) => collect(n, negated));
      return;
    }
    if ('not' in node) {
      collect(node.not, !negated);
      return;
    }
    const raw = evaluateLeafTri(ctx, node);
    const eff = negated ? kleeneNot(raw) : raw;
    const desc = describeLeaf(node, negated);
    if (eff === true) matched.push(desc);
    else if (eff === 'unknown') toConfirm.push(desc);
    else excluded.push(desc);
  };
  nodes.forEach((n) => collect(n, false));

  const overall: TriBool =
    nodes.length === 0 ? false : kleeneAll(nodes.map((n) => evaluateNodeTri(ctx, n)));
  const status = overall === true ? 'matched' : overall === 'unknown' ? 'toConfirm' : 'excluded';
  return {
    status,
    reason: status === 'excluded' ? '' : renderReasonTri(rule.reason, ctx),
    matched,
    toConfirm,
    excluded,
  };
}
