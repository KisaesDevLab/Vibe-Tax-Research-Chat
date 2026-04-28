#!/usr/bin/env tsx
// Phase 27 — restore CLI. Drains Redis queues, drops + recreates the DB,
// loads the backup, and re-runs migrations.
//
// Usage:
//   pnpm tsx scripts/restore.ts ./backups/vibe-2026-04-27.sql.gz
//
// Optional env:
//   COMPOSE_FILE  — path to the compose file (default ./docker-compose.prod.yml)
//   COMPOSE_PROJECT_NAME — compose project name (default: directory name)
//
// Prerequisites:
//   - The compose stack is running (api / postgres / redis up).
//   - The backup file is reachable from the host running this script.
//
// Portability: the script copies the backup file INTO the postgres
// container and runs gunzip + psql there, so it works on hosts that
// don't have `gunzip` in PATH (Windows, minimal Linux images, etc.).
//
// This script does NOT touch attachments/ or workspaces/ — restore those
// from the same-stamped sidecar archive if needed.
import { execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

const COMPOSE_FILE = process.env.COMPOSE_FILE ?? 'docker-compose.prod.yml';
const dc = `docker compose -f ${COMPOSE_FILE}`;

function run(cmd: string) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: pnpm tsx scripts/restore.ts <backup.sql.gz>');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  // 1. Drain Redis (queues + rate limits + cached sessions).
  run(`${dc} exec -T redis redis-cli FLUSHALL`);

  // 2. Drop & recreate the DB. -d postgres so we're not connected to
  //    vibe_tax when we drop it. WITH (FORCE) terminates other
  //    connections (e.g. the api container's pool) automatically.
  run(
    `${dc} exec -T postgres psql -U vibe -d postgres -c "DROP DATABASE IF EXISTS vibe_tax WITH (FORCE)"`,
  );
  run(`${dc} exec -T postgres psql -U vibe -d postgres -c "CREATE DATABASE vibe_tax"`);

  // 3. Copy the backup file into the postgres container, then gunzip +
  //    psql it inside the container. Avoids requiring `gunzip` on the
  //    host (Windows ships without it).
  const inContainerPath = '/tmp/vibe-restore.sql.gz';
  // docker compose cp doesn't accept --quiet on older versions; the
  // output is a single line so don't bother suppressing it.
  run(`${dc} cp "${abs}" postgres:${inContainerPath}`);
  run(
    `${dc} exec -T postgres sh -c "gunzip -c ${inContainerPath} | psql -U vibe -v ON_ERROR_STOP=1 vibe_tax"`,
  );
  run(`${dc} exec -T postgres rm -f ${inContainerPath}`);

  // 4. Re-run migrations so any schema added since the backup applies.
  //    The prod runtime image doesn't expose pnpm scripts; the compiled
  //    migrate.js sits at packages/db/dist/migrate.js.
  run(`${dc} exec -T api node packages/db/dist/migrate.js`);

  // 5. TODO Phase 27 follow-up: enqueue a skills:sync dry-run so the
  //    admin sees any pack drift since the backup was taken.

  console.log('Restore complete.');
}

main().catch((err) => {
  console.error('Restore failed:', err);
  process.exit(1);
});
