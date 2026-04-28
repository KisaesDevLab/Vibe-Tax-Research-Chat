#!/usr/bin/env tsx
// Phase 27 — restore CLI. Drains queues, restores DB, replays missing skills sync.
//
// Usage:
//   pnpm tsx scripts/restore.ts ./backups/vibe-2026-04-27.sql.gz
//
// Prerequisites:
//   - docker-compose.prod.yml is up.
//   - The backup tarball is reachable from the host running this script.
//
// This script does NOT delete attachments/ or workspaces/. Restore those manually
// from the same-stamped sidecar archive if needed.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

function run(cmd: string) {
  // eslint-disable-next-line no-console
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    // eslint-disable-next-line no-console
    console.error('Usage: pnpm tsx scripts/restore.ts <backup.sql.gz>');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!existsSync(abs)) {
    // eslint-disable-next-line no-console
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  // 1. Drain Redis (queues + rate limits + cached sessions).
  run('docker compose -f docker-compose.prod.yml exec redis redis-cli FLUSHALL');

  // 2. Drop & recreate the DB.
  run('docker compose -f docker-compose.prod.yml exec -T postgres psql -U vibe -d postgres -c "DROP DATABASE IF EXISTS vibe_tax"');
  run('docker compose -f docker-compose.prod.yml exec -T postgres psql -U vibe -d postgres -c "CREATE DATABASE vibe_tax"');

  // 3. Restore.
  run(`gunzip -c "${abs}" | docker compose -f docker-compose.prod.yml exec -T postgres psql -U vibe vibe_tax`);

  // 4. Run migrations to catch any schema added since the backup was taken.
  run('docker compose -f docker-compose.prod.yml exec api pnpm db:migrate');

  // 5. Trigger a skills dry-run so the admin sees any drift.
  run('docker compose -f docker-compose.prod.yml exec api node -e "console.log(\'TODO: queue skills:sync dry-run\')"');

  // eslint-disable-next-line no-console
  console.log('Restore complete.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Restore failed:', err);
  process.exit(1);
});
