// Guards the canonical fact-schema.json against drift from the TS surface.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FACT_SCHEMA_VERSION, FACT_SECTIONS, emptyFactPattern } from './types.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fact-schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  version: string;
  $id: string;
  required: string[];
  properties: Record<string, unknown>;
};

describe('fact-schema.json', () => {
  it('version tag matches FACT_SCHEMA_VERSION', () => {
    expect(schema.version).toBe(FACT_SCHEMA_VERSION);
    expect(schema.$id.endsWith(`/${FACT_SCHEMA_VERSION}`)).toBe(true);
  });

  it('sections match FACT_SECTIONS exactly', () => {
    expect(Object.keys(schema.properties).sort()).toEqual([...FACT_SECTIONS].sort());
    expect([...schema.required].sort()).toEqual([...FACT_SECTIONS].sort());
  });

  it('emptyFactPattern covers every section', () => {
    expect(Object.keys(emptyFactPattern()).sort()).toEqual([...FACT_SECTIONS].sort());
  });
});
