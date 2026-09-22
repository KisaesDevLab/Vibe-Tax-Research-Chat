// Adapter module for the `vibe-auth` CLI (break-glass account management):
//
//   pnpm --filter @vibe/api vibe-auth breakglass ensure | rotate | status
//
// apps/api/package.json → "vibeAuth": { "adapter": "./src/vibeAuthAdapter.ts" }
// points the CLI here; the `vibe-auth` script runs the CLI under tsx so this
// TypeScript module loads. Inside the image the appliance console runs, from
// WORKDIR /app,
//
//   node apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json
//
// with VIBE_AUTH_ADAPTER=/app/apps/api/dist/vibeAuthAdapter.js baked in by
// the Dockerfile (the CLI resolves package.json from its cwd, which is /app,
// not apps/api). It runs with the same env as the API (DATABASE_URL,
// MASTER_KEY, JWT_* — config/env.ts validates them) and never starts the
// engine or Express.
import type { VibeAuthCliAdapter } from '@kisaesdevlab/vibe-auth';
import { closeDb } from '@vibe/db';
import {
  BREAKGLASS_USERNAME,
  VIBE_TRC_ROLES,
  breakglassEmailFor,
  createVibeUsers,
  vibeAuditSink,
} from './lib/vibeAuthUsers.js';

const adapter: VibeAuthCliAdapter = {
  users: createVibeUsers(),
  audit: vibeAuditSink,
  adminRole: VIBE_TRC_ROLES.adminRole,
  breakglassEmail: breakglassEmailFor(BREAKGLASS_USERNAME),
  close: () => closeDb(),
};

export default adapter;
