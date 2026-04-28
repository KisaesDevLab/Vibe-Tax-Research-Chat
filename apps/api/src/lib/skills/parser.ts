// Phase 7 — SKILL.md parser. Reads YAML frontmatter and computes a content hash
// over SKILL.md + every referenced file in references/, scripts/, shared/.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import YAML from 'yaml';
import type { ParsedSkill, SkillFrontmatter, SkillStatus } from '@vibe/shared';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export interface ParseInput {
  skill_dir: string; // absolute path to a single skill directory (contains SKILL.md)
}

export async function parseSkill(input: ParseInput): Promise<ParsedSkill> {
  const skillMdPath = path.join(input.skill_dir, 'SKILL.md');
  const raw = await fs.readFile(skillMdPath, 'utf-8');
  const m = raw.match(FRONTMATTER_RE);
  if (!m) throw new Error(`SKILL.md is missing YAML frontmatter: ${skillMdPath}`);
  const fm = YAML.parse(m[1]!) as SkillFrontmatter;
  if (!fm?.name || !fm.description) {
    throw new Error(`SKILL.md frontmatter must have "name" and "description": ${skillMdPath}`);
  }
  const slug = fm.name.toLowerCase();
  const status: SkillStatus = fm.status ?? 'draft';

  const files = await collectFiles(input.skill_dir);
  const hash = crypto.createHash('sha256');
  // Order-stable: sort by relative path.
  files.sort((a, b) => a.rel_path.localeCompare(b.rel_path));
  hash.update(raw, 'utf-8');
  for (const f of files) {
    if (f.rel_path === 'SKILL.md') continue;
    const buf = await fs.readFile(path.join(input.skill_dir, f.rel_path));
    hash.update(`\0${f.rel_path}\0`);
    hash.update(buf);
  }

  return {
    local_slug: slug,
    display_name: humanize(slug),
    description: fm.description,
    category: fm.category ?? null,
    status_field: status,
    routing_keywords: fm.routing_keywords ?? [],
    github_path: path.basename(input.skill_dir),
    sha256: hash.digest('hex'),
    files,
  };
}

async function collectFiles(
  dir: string,
  rel = '',
): Promise<Array<{ rel_path: string; size_bytes: number }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ rel_path: string; size_bytes: number }> = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // Only descend into expected subdirs to avoid leaking VCS data.
      if (['references', 'scripts', 'shared', 'examples'].includes(e.name) || rel) {
        out.push(...(await collectFiles(full, relPath)));
      }
    } else {
      const stat = await fs.stat(full);
      out.push({ rel_path: relPath, size_bytes: stat.size });
    }
  }
  return out;
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
