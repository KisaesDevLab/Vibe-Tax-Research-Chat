// Phase 28 — first-run wizard endpoints. Auth-free, but only available when
// zero admins exist in the DB. Safe to call any time after setup — returns 409.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { eq, count } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { users } from '@vibe/db/schema';
import { audit } from '../lib/audit.js';

export const setupRouter = Router();

setupRouter.get('/status', async (_req, res) => {
  const [{ value }] = await getDb().select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  res.json({ admin_exists: Number(value) > 0 });
});

const bootstrapSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8),
  display_name: z.string().min(1).default('Administrator'),
});

setupRouter.post('/bootstrap', async (req, res) => {
  const [{ value }] = await getDb().select({ value: count() }).from(users).where(eq(users.role, 'admin'));
  if (Number(value) > 0) {
    res.status(409).json({ error: 'admin_already_exists' });
    return;
  }
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const password_hash = await bcrypt.hash(parsed.data.password, 12);
  await getDb().insert(users).values({
    email: parsed.data.email,
    password_hash,
    role: 'admin',
    display_name: parsed.data.display_name,
    is_active: true,
  });
  await audit({ action: 'setup.bootstrap', metadata: { email: parsed.data.email }, ip: req.ip });
  res.status(201).json({ ok: true });
});
