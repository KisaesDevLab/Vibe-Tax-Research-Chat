// Phase 8 — versioned sync engine. Dry-run produces a diff; apply writes
// skill_versions rows and (Phase 9) uploads to Anthropic.
import { eq } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { skills, skill_versions, skills_sync_runs } from '@vibe/db/schema';
import { ensureRepo, listSkillDirs } from './repo.js';
import { parseSkill } from './parser.js';
import { uploadSkillToAnthropic } from '../anthropic/skills.js';
import type { SyncDiff } from '@vibe/shared';

export interface DryRunOpts {
  triggered_by: string;
  pin_type: 'tag' | 'branch' | 'sha';
  pin_value: string;
}

export async function runDryRun(opts: DryRunOpts): Promise<{ run_id: string; diff: SyncDiff }> {
  const db = getDb();
  // Record the run row up-front so a failure in ensureRepo (e.g. missing tag,
  // unreachable upstream) is auditable in skills_sync_runs rather than just
  // crashing the worker.
  const [seedRun] = await db
    .insert(skills_sync_runs)
    .values({
      triggered_by: opts.triggered_by,
      pin_type: opts.pin_type,
      pin_value: opts.pin_value,
      result: 'preview',
    })
    .returning({ id: skills_sync_runs.id });
  const runId = seedRun!.id;

  let repo;
  try {
    repo = await ensureRepo({ pin_type: opts.pin_type, pin_value: opts.pin_value });
  } catch (err) {
    await db
      .update(skills_sync_runs)
      .set({
        finished_at: new Date(),
        result: 'failed',
        error_message: (err as Error).message.slice(0, 2000),
      })
      .where(eq(skills_sync_runs.id, runId));
    throw err; // surface to caller, but the run row exists.
  }

  const dirs = await listSkillDirs(repo.repo_dir);
  const parsed = await Promise.all(dirs.map((d) => parseSkill({ skill_dir: d })));

  const current = await db.select().from(skills);
  const currentBySlug = new Map(current.map((s) => [s.local_slug, s]));

  const added: SyncDiff['added'] = [];
  const updated: SyncDiff['updated'] = [];
  const removed: SyncDiff['removed'] = [];
  let unchanged = 0;

  for (const p of parsed) {
    const c = currentBySlug.get(p.local_slug);
    if (!c) {
      added.push({ slug: p.local_slug, new_sha: p.sha256 });
    } else if (c.github_sha !== p.sha256) {
      updated.push({ slug: p.local_slug, old_sha: c.github_sha ?? '', new_sha: p.sha256 });
    } else {
      unchanged++;
    }
  }
  const parsedSlugs = new Set(parsed.map((p) => p.local_slug));
  for (const c of current) {
    if (!parsedSlugs.has(c.local_slug)) {
      removed.push({ slug: c.local_slug, old_sha: c.github_sha ?? '' });
    }
  }

  const diff: SyncDiff = {
    added,
    updated,
    removed,
    unchanged_count: unchanged,
    resolved_sha: repo.resolved_sha,
    generated_at: new Date().toISOString(),
  };

  await db
    .update(skills_sync_runs)
    .set({
      resolved_sha: repo.resolved_sha,
      finished_at: new Date(),
      result: 'preview',
      changes_summary: {
        added: added.map((a) => a.slug),
        updated: updated.map((u) => u.slug),
        removed: removed.map((r) => r.slug),
        unchanged_count: unchanged,
      },
    })
    .where(eq(skills_sync_runs.id, runId));

  return { run_id: runId, diff };
}

export interface ApplyResult {
  uploaded: Array<{ slug: string; skill_id: string; version: string }>;
  failed: Array<{ slug: string; error: string }>;
  removed: string[];
}

export async function applyRun(opts: {
  run_id: string;
  applied_by: string;
  // Force a re-upload of every parsed skill, ignoring the dry-run diff.
  // Used to recover when Anthropic-side state has drifted from the DB
  // (skill deleted upstream, partial failure mid-apply, etc.).
  force?: boolean;
}): Promise<ApplyResult> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(skills_sync_runs)
    .where(eq(skills_sync_runs.id, opts.run_id))
    .limit(1);
  if (!run) throw new Error('sync run not found');

  const repo = await ensureRepo({
    pin_type: run.pin_type as 'tag' | 'branch' | 'sha',
    pin_value: run.pin_value,
  });
  const dirs = await listSkillDirs(repo.repo_dir);
  const parsed = await Promise.all(dirs.map((d) => parseSkill({ skill_dir: d })));
  const summary = run.changes_summary ?? {
    added: [],
    updated: [],
    removed: [],
    unchanged_count: 0,
  };

  const uploaded: ApplyResult['uploaded'] = [];
  const failed: ApplyResult['failed'] = [];

  for (const p of parsed) {
    if (
      !opts.force &&
      !summary.added.includes(p.local_slug) &&
      !summary.updated.includes(p.local_slug)
    )
      continue;
    try {
      const upload = await uploadSkillToAnthropic({
        local_slug: p.local_slug,
        display_name: p.display_name,
        description: p.description,
        skill_dir: dirs.find((d) => d.endsWith(p.github_path))!,
      });

      // Mark prior versions superseded
      await db
        .update(skill_versions)
        .set({ status: 'superseded' })
        .where(eq(skill_versions.skill_id, upload.skill_id));

      await db
        .insert(skills)
        .values({
          skill_id: upload.skill_id,
          source: 'pack',
          local_slug: p.local_slug,
          display_name: p.display_name,
          description: p.description,
          category: p.category,
          current_version: upload.anthropic_skill_version,
          github_path: p.github_path,
          github_sha: p.sha256,
          status_field: p.status_field,
          is_always_attached:
            p.local_slug === 'cpa-pack-index' || p.local_slug === 'compliance-ssts-circular230',
          routing_keywords: p.routing_keywords,
          uploaded_at: new Date(),
        })
        .onConflictDoUpdate({
          target: skills.skill_id,
          set: {
            current_version: upload.anthropic_skill_version,
            github_sha: p.sha256,
            status_field: p.status_field,
            uploaded_at: new Date(),
          },
        });

      await db.insert(skill_versions).values({
        skill_id: upload.skill_id,
        upstream_sha: p.sha256,
        anthropic_skill_version: upload.anthropic_skill_version,
        status: 'current',
        status_field: p.status_field,
        uploaded_by: opts.applied_by,
      });

      uploaded.push({
        slug: p.local_slug,
        skill_id: upload.skill_id,
        version: upload.anthropic_skill_version,
      });
    } catch (err) {
      // Per-skill failure: record it and keep going. The sync_run row gets
      // result='partial' if anything failed, 'success' otherwise.
      failed.push({ slug: p.local_slug, error: (err as Error).message.slice(0, 500) });
    }
  }

  // Mark removed skills inactive (preserve skill_id for historical lookup).
  const removedNames = summary.removed ?? [];
  for (const slug of removedNames) {
    await db
      .update(skills)
      .set({ is_active: false, retired_at: new Date() })
      .where(eq(skills.local_slug, slug));
  }

  await db
    .update(skills_sync_runs)
    .set({
      result: failed.length === 0 ? 'success' : 'partial',
      applied_at: new Date(),
      applied_by: opts.applied_by,
      error_message: failed.length
        ? `${failed.length} skill(s) failed: ${failed.map((f) => f.slug).join(', ')}`.slice(0, 2000)
        : null,
    })
    .where(eq(skills_sync_runs.id, opts.run_id));

  return { uploaded, failed, removed: removedNames };
}

export async function rollbackSkill(skill_id: string, version_id: string): Promise<void> {
  const db = getDb();
  await db
    .update(skill_versions)
    .set({ status: 'superseded' })
    .where(eq(skill_versions.skill_id, skill_id));
  await db
    .update(skill_versions)
    .set({ status: 'current' })
    .where(eq(skill_versions.id, version_id));
  // The actual Anthropic-side rollback (re-upload prior content) is a v1.5 follow-up.
}
