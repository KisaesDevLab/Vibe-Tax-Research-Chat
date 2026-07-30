// Phase 1 — env loader. Validates required vars at startup.
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the workspace root (apps/api/src/config -> 4 levels up).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env') });

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

    // Comma-separated CORS allowlist. Each entry is either a literal origin
    // (`https://tax.firm.com`) or a `regex:<pattern>` entry that matches
    // against the request `Origin` header. Optional — when unset OR empty,
    // falls back to PUBLIC_BASE_URL alone (preserves standalone single-origin
    // behavior). The appliance/Tailscale/emergency triplet uses this to allow
    // all three simultaneously without one origin clobbering the others.
    ALLOWED_ORIGIN: z
      .string()
      .optional()
      .transform((v) => {
        const t = v?.trim();
        return t ? t : undefined;
      }),

    // Cookie Secure-flag policy:
    //   auto  — set Secure when req.secure is true (works for HTTPS primary,
    //           Tailscale TLS, AND plain-HTTP emergency access on port 5191).
    //   true  — always Secure (production-strict; breaks emergency mode).
    //   false — never Secure (dev parity; insecure to deploy).
    // Default 'auto' is the right call once trust-proxy is set; standalone
    // installs that don't sit behind a proxy can still use 'true'.
    COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

    // Number of proxy hops to trust for X-Forwarded-* headers. Caddy /
    // appliance Caddy / HAProxy emergency-proxy all set X-Forwarded-Proto;
    // without this, req.secure stays false even on TLS connections and
    // COOKIE_SECURE=auto degrades to never-secure. Default 1 = trust the
    // immediate proxy in front of the API.
    TRUST_PROXY: z.coerce.number().int().min(0).default(1),

    // Run db migrations automatically on API startup before binding the
    // HTTP listener. Default false preserves the standalone install flow
    // (operator runs `pnpm db:migrate:prod` explicitly). The appliance
    // manifest sets this to true so the bootstrapper doesn't need a
    // separate exec step.
    MIGRATIONS_AUTO: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

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

    SKILLS_REPO_URL: z
      .string()
      .url()
      .default('https://github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills'),
    // Default to the upstream `main` branch — the skills pack is still pre-1.0
    // and has no tags yet. Admins can change this via Admin → Skills → Source.
    SKILLS_REPO_PIN_TYPE: z.enum(['tag', 'branch', 'sha']).default('branch'),
    SKILLS_REPO_PIN_VALUE: z.string().default('main'),
    SKILLS_WORKSPACE_DIR: z.string().default('./workspaces/skills'),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),

    ANTHROPIC_API_KEY: z.string().optional(),
    MODELS_MANIFEST_URL: z
      .string()
      .url()
      .default('https://vibemb.com/manifests/anthropic-models.json'),

    // Phase 32 — firm reference library embeddings.
    //   voyage     — Voyage AI (default; voyage-3-large is 1024-dim cosine).
    //   anthropic  — placeholder for when Anthropic ships first-party
    //                embeddings; not yet implemented.
    // EMBEDDINGS_API_KEY is required when EMBEDDINGS_PROVIDER is set; the
    // ingest worker fails fast with a clear error if missing.
    EMBEDDINGS_PROVIDER: z.enum(['voyage', 'anthropic']).default('voyage'),
    EMBEDDINGS_MODEL: z.string().default('voyage-3-large'),
    EMBEDDINGS_API_KEY: z.string().optional(),

    // Phase 36 — base URL for the appliance-side authority-mcp service.
    // Default works for both standalone (docker-compose service name) and
    // appliance (container in vibe-net). Override with a host:port for
    // local dev outside docker. The api never calls this from a public
    // surface; it's an internal-only side channel.
    AUTHORITY_MCP_URL: z.string().url().default('http://authority-mcp:4100'),

    BACKUP_DIR: z.string().default('./backups'),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().default(30),
    DUPLICATI_TARGET: z.string().optional(),

    // MIG-4 — Vibe AI Router dual-mode for BACKGROUND JOBS only (streaming chat
    // and strategy-watch stay direct until router backlog R1). "router" sends
    // every routable callClaude() job through the appliance's router; requires
    // both URL and token (refined below) and never silently falls back.
    VIBE_AI_MODE: z.enum(['direct', 'router']).default('direct'),
    VIBE_AI_ROUTER_URL: z
      .string()
      .optional()
      .transform((v) => (v?.trim() ? v.trim() : undefined)),
    VIBE_AI_TOKEN: z
      .string()
      .optional()
      .transform((v) => (v?.trim() ? v.trim() : undefined)),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.VIBE_AI_MODE === 'router' && (!cfg.VIBE_AI_ROUTER_URL || !cfg.VIBE_AI_TOKEN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['VIBE_AI_MODE'],
        message:
          'VIBE_AI_MODE=router requires both VIBE_AI_ROUTER_URL and VIBE_AI_TOKEN ' +
          '(the appliance mints the token during "vibe enable"), or set VIBE_AI_MODE=direct.',
      });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
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
