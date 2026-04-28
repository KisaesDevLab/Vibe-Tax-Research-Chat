// Phase 21 + 22 — custom skills CRUD + SKILL.md / zip import.
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import AdmZip from 'adm-zip';
import YAML from 'yaml';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { custom_skills } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { uploadSkillToAnthropic } from '../../lib/anthropic/skills.js';
import { logger } from '../../lib/logger.js';

export const adminCustomSkillsRouter = Router();
adminCustomSkillsRouter.use(requireAuth, requireRole('admin'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const uuidSchema = z.string().uuid();
const SLUG_RE = /^[a-z][a-z0-9-]{2,63}$/;
const RESERVED = new Set(['anthropic', 'claude', 'cpa-pack-index', 'compliance-ssts-circular230']);
const REF_FILENAME_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/;

const createSchema = z.object({
  name: z.string().regex(SLUG_RE, 'invalid slug'),
  display_name: z.string().min(1).max(120),
  description: z
    .string()
    .min(1)
    .max(1024)
    .refine((s) => !/<\/?[a-z][\s\S]*>/i.test(s), {
      message: 'description must not contain HTML/XML tags',
    }),
  category: z.string().nullable().optional(),
  body_md: z.string().min(1),
  references: z
    .array(
      z.object({
        // Allow forward-slash subdirs but reject anything that could escape (.., absolute, backslash).
        filename: z.string().regex(REF_FILENAME_RE, 'invalid reference filename'),
        content: z.string(),
      }),
    )
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

interface CustomSkillRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  category: string | null;
  body_md: string;
  references: Array<{ filename: string; content: string }> | null;
  routing_keywords: string[];
}

// Pack a custom skill row into a temp directory shaped like a pack skill so
// uploadSkillToAnthropic can zip-and-upload it. Returns the temp dir path —
// the caller is responsible for cleanup.
async function packSkillToTempDir(row: CustomSkillRow): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vibe-custom-skill-${row.name}-`));
  // Frontmatter for SKILL.md mirrors what pack skills carry.
  const frontmatter = [
    '---',
    `name: ${row.name}`,
    `description: ${JSON.stringify(row.description)}`,
    ...(row.category ? [`category: ${JSON.stringify(row.category)}`] : []),
    ...(row.routing_keywords.length
      ? [`routing_keywords: ${JSON.stringify(row.routing_keywords)}`]
      : []),
    'status: reviewed',
    '---',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), frontmatter + row.body_md, 'utf-8');

  for (const ref of row.references ?? []) {
    // The schema regex already rejects escapes; doubly defend with path.resolve check.
    const target = path.resolve(dir, ref.filename);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`unsafe reference path: ${ref.filename}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, ref.content, 'utf-8');
  }
  return dir;
}

adminCustomSkillsRouter.post('/:id/publish', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const id = req.params.id;
  const [row] = await getDb().select().from(custom_skills).where(eq(custom_skills.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let tmpDir: string | null = null;
  try {
    tmpDir = await packSkillToTempDir({
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      description: row.description,
      category: row.category,
      body_md: row.body_md,
      references: row.references,
      routing_keywords: row.routing_keywords,
    });
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
  } catch (err) {
    logger.error({ err, id }, 'custom skill publish failed');
    const msg = (err as Error).message ?? '';
    if (msg.toLowerCase().includes('anthropic api key is not configured')) {
      res.status(412).json({ error: 'anthropic_key_missing' });
    } else {
      res.status(502).json({ error: 'publish_failed', detail: msg.slice(0, 500) });
    }
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        logger.warn({ err, tmpDir }, 'temp dir cleanup failed');
      });
    }
  }
});

adminCustomSkillsRouter.post('/:id/unpublish', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  await getDb()
    .update(custom_skills)
    .set({ is_active: false })
    .where(eq(custom_skills.id, req.params.id));
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
  if (!uuidSchema.safeParse(req.params.id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
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

// Phase 22 — bulk import from a zip. Each SKILL.md must live under a
// dedicated folder (its slug); references next to it travel along.
// Per-skill flow:
//   1. parse YAML frontmatter (name, description required)
//   2. validate slug + reserved-name + tag-free description
//   3. INSERT custom_skills row (or skip on slug conflict)
//   4. POST /v1/skills via uploadSkillToAnthropic (same path as /publish)
//   5. UPDATE row with returned skill_id + version + is_active=true
// Returns a per-skill summary so partial failures don't lose progress.
interface ImportOutcome {
  slug: string;
  status: 'imported' | 'skipped' | 'failed';
  reason?: string;
  skill_id?: string;
}

const ZIP_MIME = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

adminCustomSkillsRouter.post('/import', upload.single('archive'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  if (!ZIP_MIME.has(req.file.mimetype) && !req.file.originalname.toLowerCase().endsWith('.zip')) {
    res.status(400).json({ error: 'expected_zip', mime_type: req.file.mimetype });
    return;
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(req.file.buffer);
  } catch (err) {
    res.status(400).json({ error: 'bad_zip', detail: (err as Error).message });
    return;
  }

  // Group entries by their containing folder (the slug dir).
  // The archive shape we accept matches what `git archive` / pack repos
  // produce: skills/<slug>/SKILL.md, skills/<slug>/references/...
  const bySkill = new Map<string, AdmZip.IZipEntry[]>();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const parts = e.entryName.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length < 2) continue; // SKILL.md at the very root: no folder
    // Find the folder that directly contains SKILL.md.
    const skillIdx = parts.findIndex((p, i) => i < parts.length - 1 && parts[i + 1] === 'SKILL.md');
    if (skillIdx === -1) continue;
    // For multi-segment paths under that folder, group by the slug segment.
    const slug = parts[skillIdx]!;
    if (!bySkill.has(slug)) bySkill.set(slug, []);
    bySkill.get(slug)!.push(e);
  }

  if (bySkill.size === 0) {
    res
      .status(400)
      .json({ error: 'no_skills_found', detail: 'no <slug>/SKILL.md entries in archive' });
    return;
  }

  const outcomes: ImportOutcome[] = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-import-'));
  try {
    for (const [slug, entries] of bySkill) {
      const outcome = await importOne({
        slug,
        entries,
        tmpRoot,
        actor: req.auth!.user_id,
        ip: req.ip,
      });
      outcomes.push(outcome);
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  await audit({
    actor_user_id: req.auth!.user_id,
    action: 'admin.custom_skill.import',
    metadata: {
      total: outcomes.length,
      imported: outcomes.filter((o) => o.status === 'imported').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
    },
    ip: req.ip,
  });

  res.json({ outcomes });
});

async function importOne(opts: {
  slug: string;
  entries: AdmZip.IZipEntry[];
  tmpRoot: string;
  actor: string;
  ip?: string;
}): Promise<ImportOutcome> {
  const { slug, entries, tmpRoot, actor, ip } = opts;
  if (!SLUG_RE.test(slug)) {
    return { slug, status: 'failed', reason: 'invalid slug' };
  }
  if (RESERVED.has(slug)) {
    return { slug, status: 'failed', reason: 'reserved name' };
  }

  // Find SKILL.md to extract metadata from.
  const skillMdEntry = entries.find((e) => e.entryName.replace(/\\/g, '/').endsWith('/SKILL.md'));
  if (!skillMdEntry) {
    return { slug, status: 'failed', reason: 'SKILL.md missing' };
  }
  const skillMdText = skillMdEntry.getData().toString('utf-8');
  const fmMatch = skillMdText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return { slug, status: 'failed', reason: 'SKILL.md missing YAML frontmatter' };
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = (YAML.parse(fmMatch[1]!) ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { slug, status: 'failed', reason: `YAML parse error: ${(err as Error).message}` };
  }
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : null;
  if (!description) {
    return { slug, status: 'failed', reason: 'frontmatter.description missing' };
  }
  const display_name =
    (typeof frontmatter.display_name === 'string' && frontmatter.display_name) ||
    slug
      .split('-')
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' ');

  // Conflict on slug: skip rather than overwrite, so the admin can
  // explicitly delete + re-import if they want.
  const db = getDb();
  const existing = await db
    .select({ id: custom_skills.id })
    .from(custom_skills)
    .where(eq(custom_skills.name, slug))
    .limit(1);
  if (existing.length > 0) {
    return { slug, status: 'skipped', reason: 'already exists' };
  }

  // Lay the skill out under a per-import temp dir, mirroring the same
  // shape the publish path packs.
  const skillDir = path.join(tmpRoot, slug);
  await fs.mkdir(skillDir, { recursive: true });
  for (const e of entries) {
    const inside = e.entryName.replace(/\\/g, '/').split('/');
    const idx = inside.indexOf(slug);
    if (idx === -1) continue;
    const rel = inside.slice(idx + 1).join('/');
    if (!rel) continue;
    if (!REF_FILENAME_RE.test(rel) && rel !== 'SKILL.md') continue;
    const dest = path.resolve(skillDir, rel);
    if (!dest.startsWith(path.resolve(skillDir) + path.sep) && dest !== path.resolve(skillDir)) {
      return { slug, status: 'failed', reason: `unsafe entry path: ${rel}` };
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, e.getData());
  }

  // Persist row, then upload, then mark active.
  const [row] = await db
    .insert(custom_skills)
    .values({
      name: slug,
      display_name,
      description,
      body_md: fmMatch[2] ?? '',
      references: [],
      routing_keywords: Array.isArray(frontmatter.routing_keywords)
        ? (frontmatter.routing_keywords as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [],
      is_always_attached: false,
      visibility: 'firm',
      created_by: actor,
    })
    .returning({ id: custom_skills.id });

  try {
    const upload = await uploadSkillToAnthropic({
      local_slug: slug,
      display_name,
      description,
      skill_dir: skillDir,
    });
    await db
      .update(custom_skills)
      .set({
        anthropic_skill_id: upload.skill_id,
        anthropic_skill_version: upload.anthropic_skill_version,
        is_active: true,
        updated_at: new Date(),
      })
      .where(eq(custom_skills.id, row!.id));
    await audit({
      actor_user_id: actor,
      action: 'admin.custom_skill.import.publish',
      target_type: 'custom_skill',
      target_id: row!.id,
      metadata: { slug, skill_id: upload.skill_id },
      ip,
    });
    return { slug, status: 'imported', skill_id: upload.skill_id };
  } catch (err) {
    logger.error({ err, slug }, 'custom skill import publish failed');
    return { slug, status: 'failed', reason: (err as Error).message.slice(0, 300) };
  }
}
