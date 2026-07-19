// TP-5 — golden-test runner. Walks every content record's inline
// goldenTests, resolves the apply module, composes a one-strategy
// scenario against the pinned table-set seed, and asserts the
// totalBurden delta within tolerance. CI truth is the content files;
// the DB golden_tests table (seeded from the same records) feeds the
// TP-14 runtime regression job.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeScenario } from '@vibe/engine';
import type { BaselineProfile, TableSetPayload } from '@vibe/shared';
import { listStrategyRecords } from './content.js';
import { resolveApply } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadTableSet(taxYear: number): TableSetPayload {
  const file = path.resolve(__dirname, `../../db/seeds/table-sets/${taxYear}.json`);
  return (JSON.parse(readFileSync(file, 'utf-8')) as { payload: TableSetPayload }).payload;
}

const records = listStrategyRecords().filter(
  (r) => r.modeled && r.model && r.model.goldenTests.length > 0,
);

describe('strategy goldens', () => {
  if (records.length === 0) {
    it('no modeled content yet (goldens arrive with TP-6)', () => {
      expect(records).toHaveLength(0);
    });
    return;
  }

  for (const record of records) {
    describe(record.id, () => {
      it('has at least 2 goldens (publish gate)', () => {
        expect(record.model!.goldenTests.length).toBeGreaterThanOrEqual(2);
      });

      for (const golden of record.model!.goldenTests) {
        it(golden.name, () => {
          const tableSet = loadTableSet(record.effectiveTaxYears.from);
          const profile = golden.profile as unknown as BaselineProfile;
          const apply = resolveApply(record.model!.apply.module);
          const baseline = composeScenario({
            baseline: profile,
            transforms: [],
            years: 1,
            growthPct: 0,
            tableSet,
            startYear: record.effectiveTaxYears.from,
          });
          const withStrategy = composeScenario({
            baseline: profile,
            transforms: [
              {
                strategyId: record.id,
                applyOrder: record.model!.applyOrder,
                params: golden.params,
                apply,
              },
            ],
            years: 1,
            growthPct: 0,
            tableSet,
            startYear: record.effectiveTaxYears.from,
          });
          const delta = withStrategy.years[0]!.totalBurden - baseline.years[0]!.totalBurden;
          expect(Math.abs(delta - golden.expect.totalBurdenDelta)).toBeLessThanOrEqual(
            golden.expect.tolerance,
          );
        });
      }
    });
  }
});
