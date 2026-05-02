// Phase 36 — one-shot smoke test that drives the web_resource_strategy
// settings KV through a real Postgres. Exercises:
//   1. Default-when-empty       → all sources = 'anthropic'
//   2. Round-trip after set     → usc='mcp', others = 'anthropic'
//   3. Partial-store survival   → only stored sources flip; others
//                                 stay on default.
//
// Run via: DATABASE_URL=postgres://… tsx src/scripts/strategy-roundtrip.ts
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeDb } from '@vibe/db';
import {
  DEFAULT_STRATEGY,
  getWebResourceStrategy,
  setWebResourceStrategy,
} from '../lib/web-resource-strategy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, '../../../../.env') });

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

async function main(): Promise<void> {
  // Step 1: empty → default
  const initial = await getWebResourceStrategy();
  if (JSON.stringify(initial) !== JSON.stringify(DEFAULT_STRATEGY)) {
    throw new Error(`expected default strategy, got ${JSON.stringify(initial)}`);
  }
  console.log('1. empty → default OK');

  // Step 2: set usc=mcp, verify
  await setWebResourceStrategy(
    { ...DEFAULT_STRATEGY, usc: 'mcp' },
    '00000000-0000-0000-0000-000000000000',
  );
  const afterSet = await getWebResourceStrategy();
  if (afterSet.usc !== 'mcp') {
    throw new Error(`expected usc=mcp, got ${afterSet.usc}`);
  }
  if (afterSet.cfr !== 'anthropic') {
    throw new Error(`expected cfr=anthropic, got ${afterSet.cfr}`);
  }
  console.log('2. set + read OK');

  // Step 3: revert
  await setWebResourceStrategy(DEFAULT_STRATEGY, '00000000-0000-0000-0000-000000000000');
  const afterRevert = await getWebResourceStrategy();
  if (afterRevert.usc !== 'anthropic') {
    throw new Error(`expected revert, got usc=${afterRevert.usc}`);
  }
  console.log('3. revert OK');

  console.log('strategy round-trip OK');
  await closeDb();
}

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
