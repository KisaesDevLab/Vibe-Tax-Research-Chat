// Phase 34 — env for the authority-mcp service. Minimal surface: DB and
// listen port. The full @vibe/api env is over-broad for a single-purpose
// caching proxy.
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Workspace root is four levels up from apps/authority-mcp/src — same as
// apps/api's resolution path.
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  // User-Agent string for upstream fetches. Required by uscode.house.gov
  // and other federal endpoints — bare/empty UAs trip their bot filters.
  AUTHORITY_FETCH_UA: z
    .string()
    .default(
      'VibeTaxResearchAuthorityCache/1.0 (+https://github.com/KisaesDevLab/Vibe-Tax-Research-Chat)',
    ),
  // Per-fetch timeout in milliseconds. Federal sites occasionally hang;
  // we'd rather fail loudly and let Claude fall back to web_fetch.
  AUTHORITY_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid authority-mcp environment:', parsed.error.flatten().fieldErrors);
    throw new Error('authority-mcp environment validation failed');
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_t, key: string) {
    return loadEnv()[key as keyof Env];
  },
});
