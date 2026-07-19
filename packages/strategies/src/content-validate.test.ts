// TP-12 — every content record must clear all four validation gates
// (schema, citation, prose, completeness) on every test run. This is
// the CI face of docs/strategy-schema.md: a record that regresses any
// gate cannot merge.
import { describe, it, expect } from 'vitest';
import { validateStrategyRecord } from '@vibe/schema';
import { listStrategyRecords } from './content.js';
import { MODULES } from './modules/index.js';
import './index.js'; // side effect: registers every apply module

const records = listStrategyRecords();

describe('strategy content validation', () => {
  it('has content to validate', () => {
    expect(records.length).toBeGreaterThanOrEqual(10);
  });

  it.each(records.map((r) => [r.id, r] as const))('%s passes all gates', (_id, record) => {
    const result = validateStrategyRecord(record);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('every modeled record has a registered apply module', () => {
    for (const r of records.filter((r) => r.modeled)) {
      expect(MODULES, `missing module for ${r.id}`).toHaveProperty(r.model!.apply.module);
    }
  });

  it('ids are unique and match their filenames by convention', () => {
    const ids = records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('interaction references point at real strategy ids', () => {
    const known = new Set(records.map((r) => r.id));
    for (const r of records) {
      const rel = r.advisor.interactions;
      for (const ref of [...rel.requires, ...rel.conflictsWith, ...rel.synergiesWith]) {
        expect(known.has(ref), `${r.id} references unknown strategy "${ref}"`).toBe(true);
      }
    }
  });
});
