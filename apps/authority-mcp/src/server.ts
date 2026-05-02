// Phase 34 — authority-mcp HTTP entrypoint.
//
// Surface (intentionally MCP-shaped, even though we don't speak the
// protocol on the wire — that's a follow-up):
//
//   GET  /health                       cheap process check
//   GET  /health/deep                  process + DB ping
//   GET  /tools/list                   list of tools + schemas
//   POST /tools/<name>                 invoke a tool with JSON body
//
// The api process talks to this service over the docker network at
// http://authority-mcp:4100 and translates the response into Anthropic
// tool_result blocks. There is no auth on the inter-service hop —
// authority-mcp listens only on the internal network, not on the host.
import 'express-async-errors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { env } from './config.js';
import { logger } from './logger.js';
import { TOOLS, NotImplementedError } from './tools/index.js';
import { UpstreamFetchError } from './http.js';

export function createServer(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '512kb' }));
  app.use(pinoHttp({ logger }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/health/deep', async (_req, res) => {
    const start = Date.now();
    try {
      await getDb().execute(sql`SELECT 1`);
      res.json({ status: 'ok', db_latency_ms: Date.now() - start });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: (err as Error).message });
    }
  });

  // /tools/list — describe the surface so the api process can build
  // Anthropic tool definitions dynamically once Phase 36 ships.
  app.get('/tools/list', (_req, res) => {
    res.json({
      tools: Object.values(TOOLS).map((t) => ({
        name: t.name,
        description: t.description,
        implemented: t.implemented,
      })),
    });
  });

  // /tools/:name — invoke. Body is passed through the tool's zod schema;
  // the tool returns its own shape (cite + url + text + cache fields).
  app.post('/tools/:name', async (req, res) => {
    const tool = TOOLS[req.params.name];
    if (!tool) {
      res.status(404).json({ error: 'unknown_tool', tool: req.params.name });
      return;
    }
    const parsed = tool.inputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'bad_input',
        detail: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = await tool.handler(parsed.data);
      res.json({ result });
    } catch (err) {
      if (err instanceof NotImplementedError) {
        res.status(501).json({ error: err.code, tool: err.tool, message: err.message });
        return;
      }
      if (err instanceof UpstreamFetchError) {
        res.status(502).json({
          error: 'upstream_failed',
          url: err.url,
          status: err.status,
          message: err.message,
        });
        return;
      }
      throw err;
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.originalUrl });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    logger.error({ err, path: req.path }, 'authority-mcp error');
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}

// Bootstrap when invoked directly (CMD ["node", "dist/server.js"]).
// Importing the module from a test file does not start the listener —
// pathToFileURL handles Windows separators so the comparison works in
// every CI/dev environment.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const app = createServer();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'authority-mcp listening');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection (caught)');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException — exiting');
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
