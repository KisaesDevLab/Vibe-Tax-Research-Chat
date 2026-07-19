// Phase 2 — seed: bootstrap admin + model registry from §6 manifest.
import { config as loadEnv } from 'dotenv';
import bcrypt from 'bcrypt';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, closeDb } from './index.js';
import { models, users, settings, SETTING_KEYS } from './schema/index.js';
import { sql } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, '../../../.env') });

interface SeedModel {
  model_id: string;
  display_name: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  tokenizer_factor: number;
  web_fetch_unit_cost: number;
  web_search_unit_cost: number;
  web_tools_enabled: boolean;
  fetches_per_turn: number;
  searches_per_turn: number;
  is_active: boolean;
  notes?: string;
}

// Idempotent: every insert is `onConflictDoNothing`, so calling this on every
// boot (when MIGRATIONS_AUTO=true) is safe — admin-customized rows are not
// overwritten, and rows that already exist are no-ops.
export async function runSeed(): Promise<void> {
  const db = getDb();

  // 1. Models
  const seedFile = path.resolve(__dirname, '../seeds/models.json');
  const manifest: { models: SeedModel[] } = JSON.parse(readFileSync(seedFile, 'utf-8'));

  for (const m of manifest.models) {
    await db
      .insert(models)
      .values({
        model_id: m.model_id,
        display_name: m.display_name,
        input_per_mtok: m.input_per_mtok.toString(),
        output_per_mtok: m.output_per_mtok.toString(),
        cache_write_per_mtok: m.cache_write_per_mtok.toString(),
        cache_read_per_mtok: m.cache_read_per_mtok.toString(),
        tokenizer_factor: m.tokenizer_factor.toString(),
        web_fetch_unit_cost: m.web_fetch_unit_cost.toString(),
        web_search_unit_cost: m.web_search_unit_cost.toString(),
        web_tools_enabled: m.web_tools_enabled,
        fetches_per_turn: m.fetches_per_turn.toString(),
        searches_per_turn: m.searches_per_turn.toString(),
        is_active: m.is_active,
        notes: m.notes ?? null,
      })
      .onConflictDoNothing({ target: models.model_id });
  }
  console.log(`Seeded ${manifest.models.length} models.`);

  // 2. Default model setting
  await db
    .insert(settings)
    .values({
      key: SETTING_KEYS.DEFAULT_MODEL_ID,
      value: 'claude-sonnet-4-6',
      is_encrypted: false,
    })
    .onConflictDoNothing({ target: settings.key });

  // 3. Admin
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    const password_hash = await bcrypt.hash(password, 12);
    await db
      .insert(users)
      .values({
        email,
        password_hash,
        role: 'admin',
        display_name: 'Administrator',
        is_active: true,
      })
      .onConflictDoNothing({ target: users.email });
    console.log(`Seeded admin user ${email}.`);
  } else {
    console.warn('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — skipping admin seed.');
  }

  // 4. Default settings
  const defaults: Array<[string, unknown]> = [
    [SETTING_KEYS.COMPLIANCE_BANNER_ENABLED, true],
    [SETTING_KEYS.PII_STRIP_ENABLED, false],
    [SETTING_KEYS.HIDE_UNVERIFIED_CITATIONS, false],
    [SETTING_KEYS.SHOW_SKILLS_PANEL, true],
    [SETTING_KEYS.HAIKU_FALLBACK_ROUTING, false],
    [SETTING_KEYS.CHAT_RETENTION_DAYS, null],
    [SETTING_KEYS.PLANNING_ENABLED, false],
    [
      SETTING_KEYS.SKILLS_REPO_REF,
      {
        repo:
          process.env.SKILLS_REPO_URL ??
          'https://github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills',
        pin_type: process.env.SKILLS_REPO_PIN_TYPE ?? 'tag',
        pin_value: process.env.SKILLS_REPO_PIN_VALUE ?? 'v1.0.0-beta',
        last_synced_sha: null,
        last_synced_at: null,
      },
    ],
  ];
  for (const [key, value] of defaults) {
    await db
      .insert(settings)
      .values({
        key,
        value: value as Record<string, unknown> | string | number | boolean | null,
        is_encrypted: false,
      })
      .onConflictDoNothing({ target: settings.key });
  }
  console.log(`Seeded ${defaults.length} default settings.`);

  // touch updated_at to silence linter
  void sql;
}

// CLI entrypoint. `node dist/seed.js` (via `pnpm db:seed:prod`) hits this.
// Importing the module from the API package only sees `runSeed` — the
// detection block is side-effect-free. `pathToFileURL` handles Windows
// path separators and percent-encoding correctly across platforms.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runSeed()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
