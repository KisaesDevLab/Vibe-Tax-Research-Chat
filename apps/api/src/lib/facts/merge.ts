// TP-3a — pure candidate-merge logic: apply accepted extraction candidates
// onto a fact pattern, detect cross-document conflicts, and draft the
// change summary. All pure functions; the resolve route owns persistence.
import type {
  DocumentCandidateDTO,
  ConflictGroup,
  FactCandidate,
  FactPattern,
  FactSource,
} from '@vibe/shared';
import { emptyFactPattern } from '@vibe/shared';

// Arrays whose items carry no sources field in the schema.
const SOURCELESS_ARRAYS = new Set(['household.dependents', 'income.characters']);

// Section objects that carry a provenance `sources` field. `income` is NOT
// here: income.sources is the income-sources DATA array, not provenance —
// writing FactSource[] there would corrupt it.
const PROVENANCE_PARENTS = new Set(['entity', 'household']);

function clone<T>(v: T): T {
  return structuredClone(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeSources(existing: unknown, incoming: FactSource[]): FactSource[] {
  const base = Array.isArray(existing) ? (existing as FactSource[]) : [];
  const seen = new Set(base.map((s) => `${s.documentId}:${s.page}:${s.method}`));
  const out = [...base];
  for (const s of incoming) {
    const key = `${s.documentId}:${s.page}:${s.method}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

export interface AcceptedCandidate {
  candidate: FactCandidate;
  /** editedValue when staff changed it at accept time, else candidate.value. */
  value: unknown;
}

/**
 * Applies accepted candidates onto `current` (or a fresh empty pattern).
 * Scalar paths set; `[]` paths append with dedupe on identical values.
 * Unknown/broken paths are skipped (extraction is untrusted input) — the
 * caller validates the final pattern with the zod gate before persisting.
 */
export function applyCandidates(
  current: FactPattern | null,
  accepted: AcceptedCandidate[],
): FactPattern {
  const facts = current ? clone(current) : emptyFactPattern();
  const root = facts as unknown as Record<string, unknown>;

  for (const { candidate, value } of accepted) {
    const isAppend = candidate.path.endsWith('[]');
    const rawPath = isAppend ? candidate.path.slice(0, -2) : candidate.path;
    const segments = rawPath.split('.');
    if (segments.length === 0 || segments.some((s) => !s)) continue;

    // Walk to the parent of the terminal segment.
    let node: Record<string, unknown> = root;
    let broken = false;
    for (const seg of segments.slice(0, -1)) {
      const next = node[seg];
      if (!isPlainObject(next)) {
        broken = true;
        break;
      }
      node = next;
    }
    if (broken) continue;
    const last = segments[segments.length - 1]!;

    if (isAppend) {
      const arr = node[last];
      if (!Array.isArray(arr)) continue;
      const entry = clone(value);
      const entryKey = JSON.stringify(
        isPlainObject(entry) ? { ...entry, sources: undefined } : entry,
      );
      const duplicate = arr.some(
        (existing) =>
          JSON.stringify(
            isPlainObject(existing) ? { ...existing, sources: undefined } : existing,
          ) === entryKey,
      );
      if (duplicate) {
        // Same value already present — merge provenance onto it instead.
        if (!SOURCELESS_ARRAYS.has(rawPath)) {
          const existing = arr.find(
            (e) => JSON.stringify(isPlainObject(e) ? { ...e, sources: undefined } : e) === entryKey,
          );
          if (isPlainObject(existing)) {
            existing.sources = mergeSources(existing.sources, candidate.sources);
          }
        }
        continue;
      }
      if (isPlainObject(entry) && !SOURCELESS_ARRAYS.has(rawPath)) {
        entry.sources = mergeSources(entry.sources, candidate.sources);
      }
      arr.push(entry);
    } else {
      node[last] = clone(value);
      // Provenance lands on the nearest object node that carries a
      // provenance field ('entity.type' → entity.sources). Root-level
      // scalars (narrative) and income.* carry none by schema.
      const parentPath = segments.slice(0, -1).join('.');
      if (PROVENANCE_PARENTS.has(parentPath)) {
        node.sources = mergeSources(node.sources, candidate.sources);
      }
    }
  }
  return facts;
}

/**
 * Conflicts exist only on SCALAR paths: the same path proposed with
 * differing values (across documents or within one). Array-path candidates
 * append and never conflict (applied default).
 */
export function computeConflicts(pending: DocumentCandidateDTO[]): ConflictGroup[] {
  const byPath = new Map<string, DocumentCandidateDTO[]>();
  for (const item of pending) {
    if (item.candidate.path.endsWith('[]')) continue;
    const list = byPath.get(item.candidate.path);
    if (list) list.push(item);
    else byPath.set(item.candidate.path, [item]);
  }
  const groups: ConflictGroup[] = [];
  for (const [path, items] of byPath) {
    if (items.length < 2) continue;
    const values = new Set(items.map((i) => JSON.stringify(i.candidate.value)));
    if (values.size > 1) groups.push({ path, candidates: items });
  }
  return groups.sort((a, b) => a.path.localeCompare(b.path));
}

export function draftChangeSummary(
  accepted: AcceptedCandidate[],
  documents: Array<{ id: string; filename: string }>,
): string {
  const docNames = new Map(documents.map((d) => [d.id, d.filename]));
  const usedDocs = new Set<string>();
  let edited = 0;
  for (const { candidate, value } of accepted) {
    for (const s of candidate.sources) {
      const name = docNames.get(s.documentId);
      if (name) usedDocs.add(name);
    }
    if (value !== candidate.value && JSON.stringify(value) !== JSON.stringify(candidate.value)) {
      edited += 1;
    }
  }
  const from = usedDocs.size ? ` from ${[...usedDocs].join(', ')}` : '';
  const edits = edited ? `; edited ${edited}` : '';
  return `Accepted ${accepted.length} fact${accepted.length === 1 ? '' : 's'}${from}${edits}`;
}
