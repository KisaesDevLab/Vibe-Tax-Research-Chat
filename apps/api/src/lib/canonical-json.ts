// TP-11 — canonical JSON serialization for reproducible hashing.
// Postgres jsonb does not preserve key order (or duplicate keys), so
// hashing a plain JSON.stringify of a round-tripped snapshot would give a
// different digest than the one stored at archive time. Canonical form:
// object keys sorted lexicographically at every depth, arrays in place,
// no whitespace. Hash THIS both at freeze time and at verification time.
import { createHash } from 'node:crypto';

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // undefined inside arrays serializes as null (JSON.stringify parity).
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // undefined-valued keys are dropped, matching JSON.stringify.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}
