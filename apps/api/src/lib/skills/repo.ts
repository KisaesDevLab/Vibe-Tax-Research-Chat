// Phase 7-8 — git operations against the upstream skills repo.
import simpleGit, { type SimpleGit } from 'simple-git';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

export interface RepoState {
  repo_dir: string;
  resolved_sha: string;
}

export async function ensureRepo(opts?: {
  pin_type?: 'tag' | 'branch' | 'sha';
  pin_value?: string;
  url?: string;
}): Promise<RepoState> {
  const url = opts?.url ?? env.SKILLS_REPO_URL;
  const pin_type = opts?.pin_type ?? env.SKILLS_REPO_PIN_TYPE;
  const pin_value = opts?.pin_value ?? env.SKILLS_REPO_PIN_VALUE;

  const dir = path.resolve(env.SKILLS_WORKSPACE_DIR);
  await fs.mkdir(path.dirname(dir), { recursive: true });

  let git: SimpleGit;
  if (await exists(path.join(dir, '.git'))) {
    git = simpleGit(dir);
    await git.fetch(['--tags', '--prune']);
  } else {
    await fs.mkdir(dir, { recursive: true });
    git = simpleGit(dir);
    logger.info({ url, dir }, 'cloning skills repo');
    await git.clone(url, dir);
  }

  const ref =
    pin_type === 'tag' ? `tags/${pin_value}` : pin_type === 'branch' ? `origin/${pin_value}` : pin_value;
  await git.checkout(ref);
  const sha = (await git.revparse(['HEAD'])).trim();
  return { repo_dir: dir, resolved_sha: sha };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listSkillDirs(repo_dir: string): Promise<string[]> {
  const root = path.join(repo_dir, 'skills');
  const out: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (await exists(path.join(root, e.name, 'SKILL.md'))) {
        out.push(path.join(root, e.name));
      }
    }
  } catch {
    // skills/ dir absent: nothing to ingest yet
  }
  return out;
}
