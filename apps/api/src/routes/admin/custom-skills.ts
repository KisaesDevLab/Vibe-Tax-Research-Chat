// Phase 21 + 22 — custom skills CRUD + SKILL.md / zip import.
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { custom_skills } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { uploadSkillToAnthropic } from '../../lib/anthropic/skills.js';

export const adminCustomSkillsRouter = Router();
adminCustomSkillsRouter.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;
const RESERVED = new Set(['anthropic', 'claude', 'cpa-pack-index', 'compliance-ssts-circular230']);

const createSchema = z.object({
  name: z.string().regex(SLUG_RE, 'invalid slug'),
  display_name: z.string().min(1).max(120),
  description: z.string().min(1).max(1024).refine((s) => !/<\/?[a-z][\s\S]*>/i.test(s), {
    message: 'description must not contain HTML/XML tags',
  }),
  category: z.string().nullable().optional(),
  body_md: z.string().min(1),
  references: z
    .array(z.object({ filename: z.string(), content: z.string() }))
    .max(20)
    .default([]),
  routing_keywords: z.array(z.string()).max(50).default([]),
  is_always_attached: z.boolean().default(false),
  visibility: z.enum(['firm', 'role:user', 'role:admin']).default('firm'),
});

adminCustomSkillsRouter.get('/', async (_req, res) => {
  const rows = await getDb().select().from(custom_skills).orderBy(custom_skills.created_at);
  res.json({ custom_skills: rows });
});

adminCustomSkillsRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  if (RESERVED.has(parsed.data.name)) {
    res.status(400).json({ error: 'reserved_name' });
    return;
  }
  const inserted = await getDb()
    .insert(custom_skills)
    .values({
      name: parsed.data.name,
      display_name: parsed.data.display_name,
      description: parsed.data.description,
      category: parsed.data.category ?? null,
      body_md: parsed.data.body_md,
      references: parsed.data.references,
      routing_keywords: parsed.data.routing_keywords,
      is_always_attached: parsed.data.is_always_attached,
      visibility: parsed.data.visibility,
      created_by: req.auth!.user_id,
    })
    .returning({ id: custom_skills.id });
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.custom_skill.create',
    target_type: 'custom_skill',
    target_id: inserted[0]!.id,
    ip: req.ip,
  });
  res.status(201).json({ id: inserted[0]!.id });
});

adminCustomSkillsRouter.post('/:id/publish', async (req, res) => {
  const id = req.params.id;
  const [row] = await getDb().select().from(custom_skills).where(eq(custom_skills.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // TODO Phase 21: write the skill to a temp dir, then upload.
  // The upload path is the same as pack skills.
  const tmpDir = `/tmp/custom-skill-${id}`;
  // Stub — the temp-dir packaging step is concrete in Phase 21 follow-up.
  const upload = await uploadSkillToAnthropic({
    local_slug: row.name,
    display_name: row.display_name,
    description: row.description,
    skill_dir: tmpDir,
  });
  await getDb()
    .update(custom_skills)
    .set({
      anthropic_skill_id: upload.skill_id,
      anthropic_skill_version: upload.anthropic_skill_version,
      is_active: true,
      updated_at: new Date(),
    })
    .where(eq(custom_skills.id, id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.custom_skill.publish',
    target_type: 'custom_skill',
    target_id: id,
    metadata: { skill_id: upload.skill_id, version: upload.anthropic_skill_version },
    ip: req.ip,
  });
  res.json({ ok: true, skill_id: upload.skill_id, version: upload.anthropic_skill_version });
});

adminCustomSkillsRouter.post('/:id/unpublish', async (req, res) => {
  await getDb().update(custom_skills).set({ is_active: false }).where(eq(custom_skills.id, req.params.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.custom_skill.unpublish',
    target_type: 'custom_skill',
    target_id: req.params.id,
    ip: req.ip,
  });
  res.status(204).end();
});

adminCustomSkillsRouter.delete('/:id', async (req, res) => {
  await getDb().delete(custom_skills).where(eq(custom_skills.id, req.params.id));
  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.custom_skill.delete',
    target_type: 'custom_skill',
    target_id: req.params.id,
    ip: req.ip,
  });
  res.status(204).end();
});

// Phase 22 — bulk import from a zip / SKILL.md upload.
// TODO Phase 22: parse the zip, validate each SKILL.md frontmatter, dry-run,
// then publish each. For now this returns a not_implemented.
adminCustomSkillsRouter.post('/import', upload.single('archive'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  // TODO: extract zip, walk skills/, validate, publish.
  res.status(501).json({ error: 'not_implemented', received_bytes: req.file.size });
});
