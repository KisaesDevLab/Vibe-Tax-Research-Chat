// TP-5 — content loader. Records live as JSON files in content/ (copied
// to dist/content at build); the db seed and the golden runner both read
// through this function so there is exactly one source of truth.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategyRecord } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function contentDir(): string {
  // dist/content when compiled; ../content when running from src (vitest).
  const distSide = path.join(__dirname, 'content');
  if (existsSync(distSide)) return distSide;
  return path.resolve(__dirname, '../content');
}

export function listStrategyRecords(): StrategyRecord[] {
  const dir = contentDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as StrategyRecord);
}
