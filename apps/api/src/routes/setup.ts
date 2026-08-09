// Phase 28 — first-run wizard endpoints. Auth-free, but only available when
// zero admins exist in the DB. Safe to call any time after setup — returns 409.
//
// Race safety: the `count(admins) > 0` check and the INSERT are wrapped in a
// SERIALIZABLE transaction so two simultaneous bootstrap requests can't both
// "see no admins" and both succeed.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, count, sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users, auth_refresh_tokens } from '@vibe/db/schema';
import { audit } from '../lib/audit.js';
import { signAccess, signRefresh, hashToken } from '../lib/jwt.js';
import { setupBootstrapLimiter } from '../lib/rate-limit.js';
import multer from 'multer';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { backupDir, backupTmpDir, dataDirs } from '../config/paths.js';
import { beginRestore, defaultEngineConfig } from '../lib/backup/engine.js';
import { readJournal, redactJournal, RestoreLockError } from '../lib/backup/journal.js';
import { ACCESS_COOKIE_NAME, accessCookieOptions } from '../lib/cookies.js';

export const setupRouter = Router();

setupRouter.get('/status', async (_req, res) => {
  const rows = await getDb().select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  const value = rows[0]?.value ?? 0;
  res.json({ admin_exists: Number(value) > 0 });
});

const bootstrapSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  display_name: z.string().min(1).default('Administrator'),
});

setupRouter.post('/bootstrap', setupBootstrapLimiter, async (req, res) => {
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const password_hash = await bcrypt.hash(parsed.data.password, 12);
  const db = getDb();

  let inserted: { id: string } | undefined;
  try {
    inserted = await db.transaction(async (tx) => {
      // Lock against concurrent bootstraps. A SERIALIZABLE isolation level
      // means a second concurrent transaction will fail-and-retry rather
      // than both seeing zero admins.
      await tx.execute(sql`SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      const rows = await tx.select({ value: count() }).from(users).where(eq(users.role, 'admin'));
      const existing = Number(rows[0]?.value ?? 0);
      if (existing > 0) return undefined;
      const [row] = await tx
        .insert(users)
        .values({
          email: parsed.data.email,
          password_hash,
          role: 'admin',
          display_name: parsed.data.display_name,
          is_active: true,
        })
        .returning({ id: users.id });
      return row;
    });
  } catch (err) {
    // Unique-constraint collision (email already in use) — treat as conflict.
    res.status(409).json({ error: 'admin_already_exists', detail: (err as Error).message });
    return;
  }

  if (!inserted) {
    res.status(409).json({ error: 'admin_already_exists' });
    return;
  }

  // Issue an access + refresh token immediately so the wizard can call the
  // admin endpoints (key save, default model, sync) without a separate login.
  const refreshRow = await db
    .insert(auth_refresh_tokens)
    .values({
      user_id: inserted.id,
      token_hash: 'pending',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      user_agent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    })
    .returning({ id: auth_refresh_tokens.id });
  const jti = refreshRow[0]!.id;
  const refresh_token = signRefresh({ sub: inserted.id, jti });
  await db
    .update(auth_refresh_tokens)
    .set({ token_hash: hashToken(refresh_token) })
    .where(eq(auth_refresh_tokens.id, jti));
  const access_token = signAccess({
    sub: inserted.id,
    role: 'admin',
    email: parsed.data.email,
  });
  // Mirror into a cookie too, so /admin/queues (Bull Board) is reachable
  // immediately after bootstrap without a separate login.
  res.cookie(ACCESS_COOKIE_NAME, access_token, accessCookieOptions(req));

  await audit({
    actor_user_id: inserted.id,
    action: 'setup.bootstrap',
    metadata: { email: parsed.data.email },
    ip: req.ip,
  });

  res.status(201).json({
    ok: true,
    access_token,
    refresh_token,
    user: {
      id: inserted.id,
      email: parsed.data.email,
      display_name: parsed.data.display_name,
      role: 'admin' as const,
      is_active: true,
      monthly_spend_cap_usd: null,
      can_override_model: true,
    },
  });
});

// ── Restore instead of creating an admin ────────────────────────────────
//
// Standing up a replacement server and restoring onto it is the same act,
// and this is the only moment when a restore is completely safe: no users,
// no sessions, no data to lose. Doing it here also sidesteps the failure
// mode that plagued the admin path — an authenticated operator's browser
// session holding locks on the very tables being replaced.
//
// Same trust boundary as bootstrap: allowed ONLY while zero admins exist.
// Whoever can reach an un-bootstrapped install can already claim it by
// creating the first admin, so restoring into it grants nothing further —
// and the archive is useless without its passphrase.
const restoreUpload = multer({
  storage: multer.diskStorage({
    // The backups volume, not tmpdir: multi-GB uploads must not land on
    // container tmpfs, and the engine spools live on the same volume.
    destination: (_req, _file, cb) => {
      void mkdir(backupTmpDir(), { recursive: true }).then(
        () => cb(null, backupTmpDir()),
        (err: Error) => cb(err, ''),
      );
    },
    filename: (_req, _file, cb) => cb(null, `setup-restore-${Date.now()}.vtbk`),
  }),
  limits: { fileSize: 40 * 1024 * 1024 * 1024 },
});

async function adminCount(): Promise<number> {
  const rows = await getDb().select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  return Number(rows[0]?.value ?? 0);
}

setupRouter.get('/restore/status', async (_req, res) => {
  const j = await readJournal(backupDir());
  if (!j) {
    res.json({ status: 'idle' });
    return;
  }
  res.json(j.status === 'succeeded' ? j : redactJournal(j));
});

setupRouter.post(
  '/restore',
  setupBootstrapLimiter,
  restoreUpload.single('file'),
  async (req, res) => {
    const file = req.file;
    const passphrase = String((req.body as { passphrase?: string }).passphrase ?? '');
    const cleanup = () => rm(file?.path ?? '', { force: true }).catch(() => {});
    if (!file || !passphrase) {
      await cleanup();
      res
        .status(400)
        .json({ error: 'bad_request', message: 'A backup file and passphrase are required.' });
      return;
    }
    if ((await adminCount()) > 0) {
      await cleanup();
      res.status(409).json({
        error: 'already_bootstrapped',
        message:
          'This install already has an admin. Restore from Admin → Backup & restore instead.',
      });
      return;
    }
    try {
      // No actor to attribute this to yet — the accounts arrive with the
      // archive.
      const { id } = await beginRestore(
        {
          kind: 'upload',
          file: file.path,
          name: file.originalname || path.basename(file.path),
          deleteAfter: true,
        },
        passphrase,
        defaultEngineConfig('setup', null, {
          dataDirs: dataDirs(),
          backupDir: backupDir(),
          backupTmpDir: backupTmpDir(),
        }),
      );
      res.status(202).json({ id, status: 'running' });
    } catch (err) {
      await cleanup();
      if (err instanceof RestoreLockError) {
        res
          .status(409)
          .json({ error: 'restore_in_progress', message: 'A restore is already running.' });
        return;
      }
      throw err;
    }
  },
);
