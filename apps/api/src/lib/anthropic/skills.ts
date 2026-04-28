// Phase 9 — POST /v1/skills wrapper with the skills-2025-10-02 beta header.
//
// The Anthropic SDK 0.40.1 doesn't yet have a typed `skills` resource — that
// lands in a later release. We use the SDK's raw `post<Req, Rsp>` helper so
// auth, retries, and timeout behavior come for free, and we set the beta
// header at the request level.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getAnthropic } from './client.js';
import { logger } from '../logger.js';

const SKILLS_BETA = 'skills-2025-10-02';

export interface UploadResult {
  skill_id: string;
  anthropic_skill_version: string;
}

interface SkillFileEntry {
  path: string;
  content: string; // base64
}

interface CreateSkillRequest {
  display_name: string;
  description: string;
  files: SkillFileEntry[];
}

interface CreateSkillResponse {
  id: string;
  version: string;
}

export async function uploadSkillToAnthropic(opts: {
  local_slug: string;
  display_name: string;
  description: string;
  skill_dir: string;
}): Promise<UploadResult> {
  const { client } = await getAnthropic();
  const files = await collectFiles(opts.skill_dir);

  try {
    const res = await client.post<CreateSkillRequest, CreateSkillResponse>('/v1/skills', {
      body: {
        display_name: opts.display_name,
        description: opts.description,
        files,
      },
      headers: { 'anthropic-beta': SKILLS_BETA },
    });
    return { skill_id: res.id, anthropic_skill_version: res.version };
  } catch (err) {
    logger.error({ err, slug: opts.local_slug }, 'skill upload failed');
    throw err;
  }
}

async function collectFiles(dir: string, rel = ''): Promise<SkillFileEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: SkillFileEntry[] = [];
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
