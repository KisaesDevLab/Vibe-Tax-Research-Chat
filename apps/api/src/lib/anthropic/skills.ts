// Phase 9 — POST /v1/skills wrapper with the skills-2025-10-02 beta header.
//
// The Anthropic Skills upload API expects multipart/form-data with one
// `files[]` entry per file (not a JSON body with base64 strings — that's
// what the SDK's typed messages endpoint takes). We bypass the typed SDK
// surface for this call and use raw fetch with the same auth headers, so
// each file is uploaded with its repo-relative path preserved as the
// filename.
//
// The Anthropic SDK 0.40.1 also has no typed `skills` resource; that lands
// in a later release. When it does, switch to the typed surface.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getAnthropic } from './client.js';
import { logger } from '../logger.js';

const SKILLS_BETA = 'skills-2025-10-02';
const ANTHROPIC_VERSION = '2023-06-01';
const SKILLS_ENDPOINT = 'https://api.anthropic.com/v1/skills';

export interface UploadResult {
  skill_id: string;
  anthropic_skill_version: string;
}

interface CollectedFile {
  rel_path: string;
  bytes: Buffer;
}

interface CreateSkillResponse {
  // Real shape per Anthropic Skills beta: confirm against their docs as the
  // beta stabilizes. We tolerate either {id, version} or
  // {skill_id, version}. Other fields ignored.
  id?: string;
  skill_id?: string;
  version?: string;
}

export async function uploadSkillToAnthropic(opts: {
  local_slug: string;
  display_name: string;
  description: string;
  skill_dir: string;
}): Promise<UploadResult> {
  const { api_key } = await getAnthropic();
  const files = await collectFiles(opts.skill_dir);

  if (files.length === 0) {
    throw new Error(`skill ${opts.local_slug} has no files to upload`);
  }

  // Anthropic requires every uploaded skill to sit under a single
  // top-level folder named for the skill, with SKILL.md at the root of
  // that folder (and references/, scripts/, etc. as siblings). If we
  // upload `SKILL.md` directly the API rejects with "SKILL.md file must
  // be exactly in the top-level folder." Prefix every path with the
  // slug so the multipart entries look like:
  //   compliance-ssts-circular230/SKILL.md
  //   compliance-ssts-circular230/references/foo.md
  const folder = opts.local_slug;

  const fd = new FormData();
  fd.append('display_name', opts.display_name);
  fd.append('description', opts.description);
  for (const f of files) {
    // Use a Blob with octet-stream — Anthropic infers nothing from MIME.
    // The third FormData.append arg sets the multipart filename header,
    // which is how the server sees the relative path.
    const blob = new Blob([new Uint8Array(f.bytes)], { type: 'application/octet-stream' });
    fd.append('files[]', blob, `${folder}/${f.rel_path}`);
  }

  let res: Response;
  try {
    res = await fetch(SKILLS_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': api_key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': SKILLS_BETA,
        // NOTE: do NOT set Content-Type — fetch + FormData attaches the
        // correct multipart/form-data; boundary header automatically.
      },
      body: fd,
    });
  } catch (err) {
    logger.error({ err, slug: opts.local_slug }, 'skill upload network failure');
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error(
      { status: res.status, body: text.slice(0, 1000), slug: opts.local_slug },
      'skill upload failed',
    );
    throw new Error(`skill upload ${opts.local_slug} → ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = (await res.json()) as CreateSkillResponse;
  const skill_id = json.skill_id ?? json.id;
  const version = json.version;
  if (!skill_id || !version) {
    throw new Error(
      `skill upload ${opts.local_slug} returned malformed response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { skill_id, anthropic_skill_version: version };
}

async function collectFiles(dir: string, rel = ''): Promise<CollectedFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: CollectedFile[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (['references', 'scripts', 'shared', 'examples'].includes(e.name) || rel) {
        out.push(...(await collectFiles(full, relPath)));
      }
    } else {
      const bytes = await fs.readFile(full);
      out.push({ rel_path: relPath, bytes });
    }
  }
  return out;
}
