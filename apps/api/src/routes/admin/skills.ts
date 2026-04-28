// Phase 8 + 10 — admin skill sync endpoints.
import { Router } from 'express';
import { z } from 'zod';
import { eq, desc, or } from 'drizzle-orm';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getDb } from '@vibe/db';
import { skills, skill_versions, skills_sync_runs } from '@vibe/db/schema';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { runDryRun, applyRun, rollbackSkill } from '../../lib/skills/sync.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

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

// View-skill content. The pack skills schema doesn't store body_md (only
// metadata) — the source lives on disk under SKILLS_WORKSPACE_DIR/skills/
// at the pinned revision. This endpoint reads SKILL.md plus reference
// files (references/, scripts/, shared/, examples/) and returns them
// inline so the admin can audit what's actually in the routed skill.
//
// Path safety: every resolved path is checked against the workspace root
// (not just the skill dir) — `path.resolve(skill_dir, '../foo')` would
// stay under the workspace but escape the skill, which we reject.
const MAX_INLINE_FILE_BYTES = 512 * 1024; // skip-inline files larger than this
const MAX_TOTAL_INLINE_BYTES = 4 * 1024 * 1024; // hard cap across the whole skill
const TEXT_EXT = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.sh',
]);

interface SkillFileEntry {
  rel_path: string;
  size_bytes: number;
  is_text: boolean;
  // present when is_text && size_bytes <= MAX_INLINE_FILE_BYTES && total budget remaining
  content?: string;
  truncated?: boolean;
}

async function walk(
  dir: string,
  rel: string,
  out: Array<{ rel: string; abs: string; size: number }>,
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // Mirror parser.ts: only descend into the conventional subdirs at the
      // top level; once we're inside one, recurse freely.
      if (rel || ['references', 'scripts', 'shared', 'examples'].includes(e.name)) {
        await walk(full, next, out);
      }
      continue;
    }
    try {
      const st = await fs.stat(full);
      out.push({ rel: next, abs: full, size: st.size });
    } catch {
      // skip unreadable
    }
  }
}

adminSkillsRouter.get('/:skill_id/content', async (req, res) => {
  const requestedId = req.params.skill_id;
  const db = getDb();
  // Look up by skill_id OR local_slug. Anthropic-issued skill_ids only
  // exist after a successful upload; if the appliance is in a state where
  // a skill is registered but never made it to Anthropic (sync that aborted
  // mid-flight, key missing the first time round, etc.) the row may carry
  // a placeholder. Falling back to local_slug also lets a future SPA call
  // the human-readable slug directly without breaking existing callers.
  const [row] = await db
    .select()
    .from(skills)
    .where(or(eq(skills.skill_id, requestedId), eq(skills.local_slug, requestedId)))
    .limit(1);
  if (!row) {
    // Help triage: dump every (skill_id, local_slug) pair so we can see
    // whether the row is genuinely absent (DB never seeded / wiped) vs
    // stored under a slightly different value (whitespace, case, etc.).
    const all = await db
      .select({ skill_id: skills.skill_id, local_slug: skills.local_slug })
      .from(skills);
    logger.warn(
      { requestedId, total_in_table: all.length, available: all.slice(0, 20) },
      'skills/content: lookup miss',
    );
    res.status(404).json({
      error: 'not_found',
      requested_id: requestedId,
      total_in_table: all.length,
      available_slugs: all.map((r) => r.local_slug).slice(0, 20),
    });
    return;
  }
  if (!row.github_path) {
    res.status(409).json({ error: 'no_github_path', detail: 'skill has no on-disk source' });
    return;
  }

  const repo_dir = path.resolve(env.SKILLS_WORKSPACE_DIR);
  const skills_root = path.join(repo_dir, 'skills');
  const skill_dir = path.resolve(skills_root, row.github_path);
  // Refuse anything that escapes the skills root — github_path is
  // user-supplied (well, upstream-supplied) and has historically been
  // a single directory name, but a malicious '../' value must not be
  // able to read arbitrary host files.
  if (!skill_dir.startsWith(skills_root + path.sep) && skill_dir !== skills_root) {
    logger.warn(
      { skill_id: row.skill_id, github_path: row.github_path },
      'skill content: refused path that escapes skills root',
    );
    res.status(400).json({ error: 'unsafe_path' });
    return;
  }
  const skillMdPath = path.join(skill_dir, 'SKILL.md');
  let body_md: string;
  try {
    body_md = await fs.readFile(skillMdPath, 'utf-8');
  } catch (err) {
    res.status(404).json({
      error: 'workspace_missing',
      detail: 'SKILL.md not found in workspace; run a sync to refresh.',
      hint: (err as Error).message.slice(0, 200),
    });
    return;
  }

  const collected: Array<{ rel: string; abs: string; size: number }> = [];
  await walk(skill_dir, '', collected);
  collected.sort((a, b) => a.rel.localeCompare(b.rel));

  let totalInlined = 0;
  const files: SkillFileEntry[] = [];
  for (const f of collected) {
    if (f.rel === 'SKILL.md') continue; // already returned as body_md
    const ext = path.extname(f.rel).toLowerCase();
    const is_text = TEXT_EXT.has(ext);
    const entry: SkillFileEntry = { rel_path: f.rel, size_bytes: f.size, is_text };
    if (
      is_text &&
      f.size <= MAX_INLINE_FILE_BYTES &&
      totalInlined + f.size <= MAX_TOTAL_INLINE_BYTES
    ) {
      try {
        entry.content = await fs.readFile(f.abs, 'utf-8');
        totalInlined += f.size;
      } catch {
        // unreadable for some reason — leave content out so the UI shows the
        // entry without crashing; the admin can pull it via the workspace shell.
      }
    } else if (is_text && f.size > MAX_INLINE_FILE_BYTES) {
      entry.truncated = true;
    }
    files.push(entry);
  }

  res.json({
    skill: row,
    body_md,
    files,
  });
});
