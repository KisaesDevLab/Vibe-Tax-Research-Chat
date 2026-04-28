// Phase 8 + 10 — admin skill sync endpoints.
import { Router } from 'express';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { skills, skill_versions, skills_sync_runs } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { runDryRun, applyRun, rollbackSkill } from '../../lib/skills/sync.js';
import { env } from '../../config/env.js';

export const adminSkillsRouter = Router();
adminSkillsRouter.use(requireAuth, requireRole('admin'));

adminSkillsRouter.get('/', async (_req, res) => {
  const db = getDb();
  const rows = await db.select().from(skills).orderBy(skills.local_slug);
  res.json({ skills: rows });
});

const syncSchema = z.object({
  pin_type: z.enum(['tag', 'branch', 'sha']).optional(),
  pin_value: z.string().optional(),
});

adminSkillsRouter.post('/sync', async (req, res) => {
  const parsed = syncSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  const { run_id, diff } = await runDryRun({
    triggered_by: `admin:${req.auth!.user_id}`,
    pin_type: parsed.data.pin_type ?? (env.SKILLS_REPO_PIN_TYPE as 'tag' | 'branch' | 'sha'),
    pin_value: parsed.data.pin_value ?? env.SKILLS_REPO_PIN_VALUE,
  });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.skills.sync.preview',
    target_type: 'sync_run',
    target_id: run_id,
    metadata: {
      added: diff.added.length,
      updated: diff.updated.length,
      removed: diff.removed.length,
    },
    ip: req.ip,
  });
  res.json({ run_id, diff });
});

const applySchema = z.object({ run_id: z.string().uuid() });

adminSkillsRouter.post('/sync/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  let result;
  try {
    result = await applyRun({ run_id: parsed.data.run_id, applied_by: req.auth!.user_id });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.toLowerCase().includes('anthropic api key is not configured')) {
      res.status(412).json({ error: 'anthropic_key_missing' });
      return;
    }
    res.status(502).json({ error: 'apply_failed', detail: msg.slice(0, 500) });
    return;
  }
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.skills.sync.apply',
    target_type: 'sync_run',
    target_id: parsed.data.run_id,
    metadata: {
      uploaded: result.uploaded.length,
      failed: result.failed.length,
      removed: result.removed.length,
    },
    ip: req.ip,
  });
  // Always 200 with the per-skill outcome — the UI renders the partial state.
  res.json(result);
});

const rollbackSchema = z.object({ skill_id: z.string(), version_id: z.string().uuid() });

adminSkillsRouter.post('/sync/rollback', async (req, res) => {
  const parsed = rollbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  await rollbackSkill(parsed.data.skill_id, parsed.data.version_id);
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.skills.rollback',
    target_type: 'skill',
    target_id: parsed.data.skill_id,
    metadata: { to_version: parsed.data.version_id },
    ip: req.ip,
  });
  res.status(204).end();
});

adminSkillsRouter.get('/runs', async (_req, res) => {
  const rows = await getDb()
    .select()
    .from(skills_sync_runs)
    .orderBy(desc(skills_sync_runs.started_at))
    .limit(50);
  res.json({ runs: rows });
});

adminSkillsRouter.get('/:skill_id/versions', async (req, res) => {
  const rows = await getDb()
    .select()
    .from(skill_versions)
    .where(eq(skill_versions.skill_id, req.params.skill_id))
    .orderBy(desc(skill_versions.uploaded_at));
  res.json({ versions: rows });
});
