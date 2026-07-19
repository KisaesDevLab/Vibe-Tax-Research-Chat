// Copies non-TS runtime assets (vendor anchor overrides) into dist so the
// compiled server finds them next to the compiled modules.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [['src/lib/intake/anchor-overrides.json', 'dist/lib/intake/anchor-overrides.json']];
for (const [from, to] of pairs) {
  mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  copyFileSync(path.join(root, from), path.join(root, to));
}
