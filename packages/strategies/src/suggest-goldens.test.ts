// TP-5a — suggest goldens: fixture fact patterns evaluated through the
// REAL content suggest rules (the exact JSON the seed ships). Also proves
// the legacy two-valued evaluator and the tri-state surface agree on every
// rule that carries no facts.* leaf.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateSuggestRule,
  evaluateSuggestRuleTri,
  type SuggestNode,
  type SuggestRule,
} from '@vibe/shared';
import { listStrategyRecords } from './content.js';

interface Fixture {
  name: string;
  profile: Record<string, unknown>;
  facts: Record<string, unknown> | null;
  expect: { matched: string[]; toConfirm: string[]; notSuggested: string[] };
  leafChecks?: Record<string, { matchedContains?: string[]; toConfirmContains?: string[] }>;
}

const fixturesPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../suggest-goldens/fixtures.json',
);
const { fixtures } = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { fixtures: Fixture[] };

const rules = new Map<string, SuggestRule>();
for (const record of listStrategyRecords()) {
  const rule = (record.modeled ? record.model?.suggest : record.suggest) as SuggestRule | undefined;
  if (rule) rules.set(record.id, rule);
}

function ruleFor(id: string): SuggestRule {
  const rule = rules.get(id);
  if (!rule) throw new Error(`no suggest rule for strategy "${id}"`);
  return rule;
}

describe('suggest goldens', () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(10);

  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const ctx = { profile: fixture.profile, facts: fixture.facts };
    for (const id of fixture.expect.matched) {
      expect(evaluateSuggestRuleTri(ctx, ruleFor(id)).status, `${id} should match`).toBe('matched');
    }
    for (const id of fixture.expect.toConfirm) {
      expect(evaluateSuggestRuleTri(ctx, ruleFor(id)).status, `${id} should be toConfirm`).toBe(
        'toConfirm',
      );
    }
    for (const id of fixture.expect.notSuggested) {
      expect(evaluateSuggestRuleTri(ctx, ruleFor(id)).status, `${id} should be excluded`).toBe(
        'excluded',
      );
    }
    for (const [id, checks] of Object.entries(fixture.leafChecks ?? {})) {
      const result = evaluateSuggestRuleTri(ctx, ruleFor(id));
      for (const needle of checks.matchedContains ?? []) {
        expect(result.matched, `${id} matched[] should contain "${needle}"`).toContain(needle);
      }
      for (const needle of checks.toConfirmContains ?? []) {
        expect(result.toConfirm, `${id} toConfirm[] should contain "${needle}"`).toContain(needle);
      }
    }
  });
});

function hasFactsLeaf(node: SuggestNode): boolean {
  if ('all' in node) return node.all.some(hasFactsLeaf);
  if ('any' in node) return node.any.some(hasFactsLeaf);
  if ('not' in node) return hasFactsLeaf(node.not);
  return node.field.startsWith('facts.');
}

function ruleHasFactsLeaf(rule: SuggestRule): boolean {
  return (
    (rule.all ?? []).some(hasFactsLeaf) ||
    (rule.any ?? []).some(hasFactsLeaf) ||
    (rule.not ? hasFactsLeaf(rule.not) : false)
  );
}

describe('legacy ↔ tri-state equivalence (rules without facts leaves)', () => {
  const sampleProfiles: Array<Record<string, unknown>> = [
    {},
    {
      businesses: [
        { kind: 'schedule-c', netProfit: 120000, employeeWages: 30000, ownerWages: 0 },
        { kind: 's-corp', netProfit: 90000, employeeWages: 0, ownerWages: 50000 },
      ],
      rentals: [{ netIncome: -8000 }],
      wages: 180000,
      dependentsUnder17: 2,
      longTermCapGain: 25000,
      state: { code: 'MO', flatRate: 0.048 },
      itemized: { charitable: 12000 },
      filingStatus: 'mfj',
    },
    { businesses: [], rentals: [], wages: 40000, filingStatus: 'single' },
  ];

  it('agree on matched for every unenriched rule × sample profile', () => {
    let checked = 0;
    for (const [id, rule] of rules) {
      if (ruleHasFactsLeaf(rule)) continue;
      for (const profile of sampleProfiles) {
        const legacy = evaluateSuggestRule(profile, rule).matched;
        const tri = evaluateSuggestRuleTri({ profile, facts: null }, rule).status === 'matched';
        expect(tri, `${id} diverged`).toBe(legacy);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200); // ~93 unenriched rules × 3 profiles
  });
});
