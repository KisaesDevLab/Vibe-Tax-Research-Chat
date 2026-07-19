// TP-5 — declarative suggest-rule evaluator. A typed JSON predicate AST
// evaluated server-side over the client profile: no eval, no runtime
// codegen (master-plan FINAL). Leaves address profile fields by dot path
// with two virtual aggregates the authoring schema relies on
// (`totalBusinessProfit`, `hasBusiness`).
export type SuggestOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists';

export interface SuggestLeaf {
  field: string;
  op: SuggestOp;
  value?: unknown;
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

function evalLeaf(profile: Record<string, unknown>, leaf: SuggestLeaf): boolean {
  const actual = resolveField(profile, leaf.field);
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
