// TP-5a — bidirectional drift guard: FACT_PATHS ↔ fact-schema.json. Any
// schema property added/removed without updating the whitelist (or vice
// versa) fails here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACT_PATHS, isValidFactField } from './fact-paths.js';
import { isValidSuggestField } from './field-whitelist.js';

const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../shared/src/facts/fact-schema.json',
);

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  $ref?: string;
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchemaNode & {
  version: string;
};

function hasType(node: JsonSchemaNode, t: string): boolean {
  return Array.isArray(node.type) ? node.type.includes(t) : node.type === t;
}

/** Derives the evaluator-relevant path set from the JSON schema, skipping
 *  provenance `sources` everywhere. */
function derivePaths(node: JsonSchemaNode, prefix: string, out: Set<string>): void {
  if (hasType(node, 'array') && node.items) {
    const arrPath = `${prefix}[]`;
    out.add(arrPath);
    if (node.items.properties) {
      for (const [k, child] of Object.entries(node.items.properties)) {
        if (k === 'sources') continue;
        derivePaths(child, `${arrPath}.${k}`, out);
      }
    }
    return;
  }
  if (node.properties) {
    for (const [k, child] of Object.entries(node.properties)) {
      if (k === 'sources' && prefix !== 'income') continue; // provenance
      derivePaths(child, prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (prefix) out.add(prefix);
}

describe('FACT_PATHS ↔ fact-schema.json', () => {
  it('matches the schema-derived path set exactly', () => {
    const derived = new Set<string>();
    for (const [section, node] of Object.entries(schema.properties!)) {
      derivePaths(node, section, derived);
    }
    expect([...derived].sort()).toEqual([...FACT_PATHS].sort());
  });

  it('isValidFactField accepts whitelisted paths only, with the facts. prefix', () => {
    expect(isValidFactField('facts.ownership[].relatedParty')).toBe(true);
    expect(isValidFactField('facts.household.dependents[]')).toBe(true);
    expect(isValidFactField('ownership[].relatedParty')).toBe(false); // no prefix
    expect(isValidFactField('facts.household.dependants[]')).toBe(false); // typo
    expect(isValidFactField('facts.entity.sources')).toBe(false); // provenance
  });

  it('isValidSuggestField spans profile, virtual, and facts namespaces', () => {
    expect(isValidSuggestField('totalBusinessProfit')).toBe(true);
    expect(isValidSuggestField('itemized.charitable')).toBe(true);
    expect(isValidSuggestField('facts.entity.type')).toBe(true);
    expect(isValidSuggestField('bogusField')).toBe(false);
  });
});
