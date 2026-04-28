import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // drizzle-kit's CJS loader cannot resolve TS-style `.js` imports.
  // Workaround: point at the compiled dist/ output (run `pnpm --filter @vibe/db build` first).
  schema: './dist/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5432/vibe_tax',
  },
  strict: true,
  verbose: true,
});
