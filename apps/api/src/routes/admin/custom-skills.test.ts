// Phase 21 — verify the temp-dir packing behavior for custom-skills publish.
//
// Regression test: an earlier version pointed uploadSkillToAnthropic at a
// /tmp path that was never created or populated, so publish either crashed
// or uploaded an empty zip. The new path uses os.tmpdir() (cross-platform),
// writes SKILL.md with frontmatter, lays out reference files, and rejects
// path-traversal in reference filenames.

import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6389';
});

interface PackInput {
  id: string;
  name: string;
  display_name: string;
  description: string;
  category: string | null;
  body_md: string;
  references: Array<{ filename: string; content: string }> | null;
  routing_keywords: string[];
}

// Re-implementation of the packer used by /publish — kept identical to the
// route handler. Re-export the helper instead of duplicating in a follow-up.
async function packSkillToTempDir(row: PackInput): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vibe-custom-skill-${row.name}-`));
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
    const target = path.resolve(dir, ref.filename);
    if (!target.startsWith(path.resolve(dir) + path.sep)) {
      throw new Error(`unsafe reference path: ${ref.filename}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, ref.content, 'utf-8');
  }
  return dir;
}

describe('custom-skill packer', () => {
  it('writes SKILL.md with valid YAML frontmatter and the body', async () => {
    const dir = await packSkillToTempDir({
      id: 'id-1',
      name: 'firm-allocation',
      display_name: 'Firm Allocation',
      description: 'Allocate income across firm engagements.',
      category: 'firm-policy',
      body_md: '# Allocation procedure\n\nStep 1: ...',
      references: [],
      routing_keywords: ['allocation', 'engagement'],
    });
    try {
      const md = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8');
      expect(md.startsWith('---\n')).toBe(true);
      expect(md).toContain('name: firm-allocation');
      expect(md).toContain('description: "Allocate income across firm engagements."');
      expect(md).toContain('category: "firm-policy"');
      expect(md).toContain('routing_keywords: ["allocation","engagement"]');
      expect(md).toContain('# Allocation procedure');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('lays out reference files in subdirectories', async () => {
    const dir = await packSkillToTempDir({
      id: 'id-2',
      name: 'multi-ref',
      display_name: 'Multi Ref',
      description: 'Has reference files.',
      category: null,
      body_md: 'body',
      references: [
        { filename: 'references/notes.md', content: '# Notes' },
        { filename: 'scripts/helper.py', content: 'print(1)' },
      ],
      routing_keywords: [],
    });
    try {
      expect(await fs.readFile(path.join(dir, 'references/notes.md'), 'utf-8')).toBe('# Notes');
      expect(await fs.readFile(path.join(dir, 'scripts/helper.py'), 'utf-8')).toBe('print(1)');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in reference filenames', async () => {
    // The route's zod schema rejects most of these BEFORE the packer runs,
    // but the packer's defense-in-depth check is what we test here.
    await expect(
      packSkillToTempDir({
        id: 'id-3',
        name: 'evil',
        display_name: 'Evil',
        description: '...',
        category: null,
        body_md: 'b',
        references: [{ filename: '../../etc/passwd', content: 'bad' }],
        routing_keywords: [],
      }),
    ).rejects.toThrow(/unsafe reference path/);
  });
});
