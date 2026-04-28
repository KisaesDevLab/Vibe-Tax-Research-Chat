// Phase 1 — env loader. Validates required vars at startup.
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Crypto. 64 hex chars = 32 bytes.
  MASTER_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'MASTER_KEY must be 64 hex chars (32 bytes)'),

  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

  SKILLS_REPO_URL: z.string().url().default('https://github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills'),
  SKILLS_REPO_PIN_TYPE: z.enum(['tag', 'branch', 'sha']).default('tag'),
  SKILLS_REPO_PIN_VALUE: z.string().default('v1.0.0-beta'),
  SKILLS_WORKSPACE_DIR: z.string().default('./workspaces/skills'),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  MODELS_MANIFEST_URL: z.string().url().default('https://vibemb.com/manifests/anthropic-models.json'),

  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().default(30),
  DUPLICATI_TARGET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
    throw new Error('Environment validation failed');
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_t, key: string) {
    return loadEnv()[key as keyof Env];
  },
});
