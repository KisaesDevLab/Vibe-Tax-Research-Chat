// TP-12 — CLI validator for content authors. Usage:
//   node scripts/validate-content.mjs [id ...]
// Runs every validation gate (via @vibe/schema dist — build it first)
// plus the TODO-marker check. Exit 1 on any failure.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStrategyRecord } from '../../schema/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(root, 'content');

const wanted = process.argv.slice(2);
const files = readdirSync(contentDir)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => wanted.length === 0 || wanted.includes(f.replace(/\.json$/, '')))
  .sort();

let failures = 0;
for (const f of files) {
  const raw = readFileSync(path.join(contentDir, f), 'utf-8');
  const record = JSON.parse(raw);
  const problems = [];
  if (raw.includes('"TODO')) {
    problems.push({ gate: 'todo', path: '(record)', message: 'unfilled TODO markers remain' });
  }
  const result = validateStrategyRecord(record);
  problems.push(
    ...result.errors.filter((e) => !(record.modeled && e.path.startsWith('model.goldenTests'))),
  );
  // Golden emptiness is expected pre-embed; flag it separately.
  if (record.modeled && (record.model?.goldenTests ?? []).length < 2) {
    problems.push({
      gate: 'goldens',
      path: 'model.goldenTests',
      message: 'goldens not yet embedded (run scripts/embed-goldens.mjs)',
    });
  }
  if (problems.length > 0) {
    failures += 1;
    console.log(`✗ ${f}`);
    for (const p of problems) console.log(`   [${p.gate}] ${p.path}: ${p.message}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
console.log(failures === 0 ? `\nall ${files.length} records pass` : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
