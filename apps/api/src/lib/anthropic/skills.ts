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
import YAML from 'yaml';
import { getAnthropic } from './client.js';
import { logger } from '../logger.js';

const SKILLS_BETA = 'skills-2025-10-02';
const ANTHROPIC_VERSION = '2023-06-01';
const SKILLS_ENDPOINT = 'https://api.anthropic.com/v1/skills';
// Cap each upload at 120s. Without a timeout, a single stalled upload
// (network glitch, Anthropic-side hiccup, rate-limit retry burning
// keepalive) hangs the whole apply loop indefinitely — the admin UI
// shows "Applying…" forever because the per-skill fetch never resolves.
const UPLOAD_TIMEOUT_MS = 120_000;

export interface UploadResult {
  skill_id: string;
  anthropic_skill_version: string;
}

interface CollectedFile {
  rel_path: string;
  bytes: Buffer;
}

interface CreateSkillResponse {
  // Anthropic Skills beta (skills-2025-10-02) returns:
  //   { type: "skill", id, display_title, source, latest_version,
  //     created_at, updated_at }
  // We tolerate older shapes (`skill_id`, `version`) too in case the field
  // names settle differently before GA.
  id?: string;
  skill_id?: string;
  latest_version?: string;
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

  // Anthropic validates: description must not contain HTML/XML tags and is
  // capped (1024 chars based on observed 400s). Two upstream pack skills
  // currently ship with `<tag>`-style placeholders in their descriptions —
  // strip them rather than fail the whole apply for a docs nit.
  const safeDescription = sanitizeForAnthropic(opts.description, 1024);
  const safeDisplayName = sanitizeForAnthropic(opts.display_name, 120);

  const fd = new FormData();
  fd.append('display_name', safeDisplayName);
  fd.append('description', safeDescription);
  for (const f of files) {
    // Anthropic reads `description` from the SKILL.md frontmatter directly
    // (not the multipart form field), and rejects any XML/HTML tags in it.
    // Two upstream pack skills currently ship with placeholder tags in
    // their description — rewrite the frontmatter description before
    // upload so the rest of the pack still applies cleanly.
    let bytes = f.bytes;
    if (f.rel_path === 'SKILL.md') {
      bytes = sanitizeSkillMd(f.bytes);
    }
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
    fd.append('files[]', blob, `${folder}/${f.rel_path}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
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
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.error(
        { slug: opts.local_slug, timeout_ms: UPLOAD_TIMEOUT_MS },
        'skill upload timed out',
      );
      throw new Error(`skill upload ${opts.local_slug} timed out after ${UPLOAD_TIMEOUT_MS}ms`);
    }
    logger.error({ err, slug: opts.local_slug }, 'skill upload network failure');
    throw err;
  } finally {
    clearTimeout(timer);
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
  const version = json.latest_version ?? json.version;
  if (!skill_id || !version) {
    throw new Error(
      `skill upload ${opts.local_slug} returned malformed response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return { skill_id, anthropic_skill_version: version };
}

// Strip HTML/XML tags and clamp length so descriptions / display names pass
// Anthropic's Skills upload validator. Some upstream pack skills ship with
// placeholder tags like `<state-code>` in their description.
function sanitizeForAnthropic(s: string, maxLen: number): string {
  const noTags = s
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return noTags.length > maxLen ? noTags.slice(0, maxLen - 1) + '…' : noTags;
}

// Rewrite SKILL.md so the YAML-frontmatter `description:` value is free of
// XML/HTML-ish tags. Parses with the `yaml` lib (handles single-line, quoted,
// and multi-line block scalars `|`/`>`), sanitizes the string, and round-
// trips back to a YAML document. Everything outside the frontmatter is left
// byte-identical.
function sanitizeSkillMd(bytes: Buffer): Buffer {
  const text = bytes.toString('utf-8');
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!m) return bytes;
  const [, openFence, frontmatter, closeFence, body] = m;
  let parsed: Record<string, unknown>;
  try {
    parsed = (YAML.parse(frontmatter!) ?? {}) as Record<string, unknown>;
  } catch {
    // If we can't parse, leave the file alone — Anthropic will reject and
    // the per-skill error will surface to the admin.
    return bytes;
  }
  if (typeof parsed.description === 'string') {
    parsed.description = sanitizeForAnthropic(parsed.description, 1024);
  }
  if (typeof parsed.name === 'string') {
    parsed.name = sanitizeForAnthropic(parsed.name, 64);
  }
  // Preserve readability: keep block-scalar style for long descriptions,
  // but with the cleaned text.
  const dumped = YAML.stringify(parsed, { lineWidth: 0 });
  return Buffer.from(`${openFence}${dumped.trimEnd()}${closeFence}${body}`, 'utf-8');
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
