// Phase 9 — POST /v1/skills wrapper with the skills-2025-10-02 beta header.
//
// The Anthropic SDK at the time of writing exposes most beta endpoints
// through `client.beta.*`. This wrapper isolates the surface so the rest of
// the app can call `uploadSkillToAnthropic(...)` without knowing about beta
// header strings or zip packaging.
import { getAnthropic } from './client.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

const SKILLS_BETA = 'skills-2025-10-02';

export interface UploadResult {
  skill_id: string;
  anthropic_skill_version: string;
}

export async function uploadSkillToAnthropic(opts: {
  local_slug: string;
  display_name: string;
  description: string;
  skill_dir: string;
}): Promise<UploadResult> {
  const { client } = await getAnthropic();

  // Walk the skill directory to package files. The wire format is a multipart
  // upload with a manifest; the SDK accepts this through `beta.skills.create`.
  // TODO Phase 9 follow-up: confirm the exact SDK shape against the released
  // version of @anthropic-ai/sdk that ships with this skill beta.
  const files = await collectFiles(opts.skill_dir);

  try {
    // The SDK call uses unknown-typed `beta` on older versions; the cast
    // below is the seam to update once the SDK pins to a stable shape.
    const res = await (client as unknown as {
      beta: {
        skills: {
          create: (args: {
            display_name: string;
            description: string;
            files: Array<{ path: string; content: string }>;
            betas: string[];
          }) => Promise<{ id: string; version: string }>;
        };
      };
    }).beta.skills.create({
      display_name: opts.display_name,
      description: opts.description,
      files,
      betas: [SKILLS_BETA],
    });
    return { skill_id: res.id, anthropic_skill_version: res.version };
  } catch (err) {
    logger.error({ err, slug: opts.local_slug }, 'skill upload failed');
    throw err;
  }
}

async function collectFiles(dir: string, rel = ''): Promise<Array<{ path: string; content: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ path: string; content: string }> = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (['references', 'scripts', 'shared', 'examples'].includes(e.name) || rel) {
        out.push(...(await collectFiles(full, relPath)));
      }
    } else {
      const buf = await fs.readFile(full);
      out.push({ path: relPath, content: buf.toString('base64') });
    }
  }
  return out;
}
