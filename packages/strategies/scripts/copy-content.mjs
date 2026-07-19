// Copies content/*.json into dist/content so listStrategyRecords() works
// from the compiled package (tsc only emits src).
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'content');
const dest = path.join(root, 'dist', 'content');

mkdirSync(dest, { recursive: true });
if (existsSync(src)) {
  for (const f of readdirSync(src).filter((f) => f.endsWith('.json'))) {
    copyFileSync(path.join(src, f), path.join(dest, f));
  }
}
