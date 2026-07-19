// TP-12 — stamps the structural spec into content skeletons. Machine
// fields (classification, model block, suggest, interactions) are final;
// prose fields are "TODO" markers the authoring pass must replace (the
// content-validate test fails on any surviving TODO). Never overwrites
// an existing record.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC } from '../spec/tp12-spec.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'content');
const TODAY = '2026-07-19';

let created = 0;
for (const s of SPEC) {
  const file = path.join(contentDir, `${s.id}.json`);
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, 'utf-8'));
    if (existing.id !== s.id) throw new Error(`id mismatch in ${file}`);
    continue;
  }
  const record = {
    id: s.id,
    version: '1.0.0',
    status: 'published',
    effectiveTaxYears: { from: 2026, to: null },
    lastReviewed: TODAY,
    reviewedBy: null,
    changeLog: [{ version: '1.0.0', date: TODAY, note: 'Initial original authoring to schema v1.0' }],
    name: s.name,
    category: s.category,
    modeled: s.modeled,
    complexity: s.complexity,
    riskRating: s.riskRating,
    entityTypes: s.entityTypes,
    typicalSavingsBand: s.savingsBand,
    advisor: {
      summary: 'TODO',
      mechanics: ['TODO', 'TODO', 'TODO'],
      authority: [
        { type: 'IRC', cite: 'TODO', note: 'TODO' },
        { type: 'IRC', cite: 'TODO', note: 'TODO' },
      ],
      requirements: ['TODO', 'TODO'],
      risks: ['TODO', 'TODO'],
      stateNotes: ['TODO'],
      interactions: s.interactions,
      reviewChecklist: ['TODO', 'TODO', 'TODO'],
    },
    client: {
      teaser: 'TODO',
      headline: 'TODO',
      plainEnglish: ['TODO', 'TODO'],
      analogy: 'TODO',
      benefits: ['TODO', 'TODO'],
      steps: ['TODO', 'TODO'],
      clientCommitments: ['TODO'],
    },
    engagement: {
      implementationEffort: s.effort,
      annualMaintenance: ['TODO'],
      deliverables: ['TODO'],
      feeGuidanceBand: null,
    },
    ...(s.modeled
      ? {
          model: {
            applyOrder: s.applyOrder,
            inputs: s.inputs,
            apply: { module: `${s.id}@1.0.0` },
            ...(s.mayIncreaseBurden ? { mayIncreaseBurden: true } : {}),
            suggest: s.suggest,
            goldenTests: [],
          },
        }
      : { suggest: s.suggest }),
    monitoring: {
      watchAuthorities: ['TODO'],
      keywords: ['TODO', 'TODO'],
      reviewTriggers: ['TODO'],
    },
  };
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  created += 1;
}
console.log(`scaffolded ${created} records (${SPEC.length} in spec)`);
