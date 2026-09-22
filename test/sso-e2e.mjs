#!/usr/bin/env node
// Single sign-on end-to-end check for Vibe Tax Research Chat (Vibe Auth
// integration plan, rule I13). Boots the real API against a scratch Postgres
// database, a scratch Redis logical database and a fake OpenID provider
// (test/fake-idp.mjs), and walks the scenarios the plan names, adapted to this
// product's stateless-JWT sessions: status in local/both, PKCE login →
// one-time code hand-off → exchange → JIT with the mapped role, existing-user
// email link + role sync, unverified email denied, /auth/settings 403/200 and
// the cookie policy, the oidc_only guard on /api/auth/login while the public
// zone still answers, refresh carrying the sid, sign-out revoking the access
// token at once, back-channel logout (user-level and sid-only), a fresh login
// afterwards, RP-initiated logout, the test-connection popup's cookie path,
// break-glass CLI + local login + audit, boot refusal without break-glass.
//
//   pnpm test:sso-e2e
//
// Prerequisites: the dev compose Postgres + Redis (docker compose up -d
// postgres redis), pnpm install done, workspace packages built
// (pnpm -r --filter '!@vibe/web' --filter '!@vibe/api' build — the api runs
// from source under tsx but imports @vibe/db & co. from their dist/).
//   E2E_PG_ADMIN_URL   admin connection (default: the compose dev instance on :5439)
//   E2E_REDIS_URL      redis url (default: redis://127.0.0.1:6389/9 — FLUSHED per run)
//   E2E_KEEP_DB=1      leave the scratch database behind for inspection
//   E2E_VERBOSE=1      stream the api's output instead of buffering it
//
// Design notes:
//   - Mode changes are RESTARTS. A successful PUT /auth/settings {mode} is
//     persisted and overrides VIBE_AUTH_MODE for every later boot, which would
//     silently break the boot-refusal scenario. The only PUTs here are refused
//     before anything is stored.
//   - The port is chosen by this script, not the child: VIBE_OIDC_PUBLIC_URL
//     (and so the redirect URI registered with the IdP) is baked in at boot.
//   - The env is a whitelist, but the api's config loads the workspace .env as
//     a FALLBACK (dotenv never overrides), so everything that matters is set
//     explicitly — including the seed admin, which is how the first admin is
//     created here (MIGRATIONS_AUTO=true runs migrations + the seed on boot).
//   - A token's `iat` has whole-second resolution while the revocation moment
//     is in milliseconds: a login in the same second as a user-level logout is
//     still revoked. The fresh-login scenario waits it out.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { FakeIdp } from './fake-idp.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API_DIR = path.join(ROOT, 'apps', 'api');
const requireDb = createRequire(realpathSync(path.join(ROOT, 'packages/db/package.json')));
const requireApi = createRequire(realpathSync(path.join(API_DIR, 'package.json')));
const postgres = requireDb('postgres');
const Redis = requireApi('ioredis').default ?? requireApi('ioredis');

// The api runs from source under tsx, from apps/api (where tsx is a devDependency).
const API_ENTRY = path.join('src', 'index.ts');
const TSX_IMPORT = ['--import', 'tsx'];
// The very command the appliance console runs inside the image (from its WORKDIR),
// with the adapter pointed at the TypeScript source instead of dist/.
const VIBE_CLI = path.join('node_modules', '@kisaesdevlab', 'vibe-auth', 'dist', 'cli.js');
const VIBE_ADAPTER = path.join(API_DIR, 'src', 'vibeAuthAdapter.ts');

const ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? 'postgres://vibe:vibe@127.0.0.1:5439/postgres';
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6389/9';
const VERBOSE = process.env.E2E_VERBOSE === '1';
const KEEP_DB = process.env.E2E_KEEP_DB === '1';

const CLIENT_ID = 'vibe-tax-research-e2e';
const CLIENT_SECRET = 's3cret';
const MASTER_KEY = randomBytes(32).toString('hex');
const JWT_SECRET = randomBytes(32).toString('hex');
const JWT_REFRESH_SECRET = randomBytes(32).toString('hex');
const ADMIN_EMAIL = 'admin@e2e.firm';
const ADMIN_PASSWORD = 'E2eAdmin!2026xyz';
const PAT_PASSWORD = 'E2ePat!2026xyz';
const KURT_PASSWORD = 'E2eKurt!2026xyz';
const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-tax.local';
const BREAKGLASS_PASSWORD = 'E2eBreakGlass!2026';

const KURT = { sub: 'u-100', email: 'kurt@kisaes.com', email_verified: true, name: 'Kurt', groups: ['vibe-partner'], amr: ['pwd', 'otp'] };
const PAT_IDP = { sub: 'u-200', email: 'pat@kisaes.com', email_verified: true, name: 'Pat', groups: ['vibe-manager'] };
const NOBODY = { sub: 'u-300', email: 'nobody@kisaes.com', email_verified: false, groups: ['vibe-partner'] };

// ─────────────────────────────────────────────────────────────── plumbing

const t0 = Date.now();
const log = (line) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${line}`);

class Ring {
  lines = [];
  push(prefix, chunk) {
    for (const l of String(chunk).split(/\r?\n/)) {
      if (!l) continue;
      const line = `${prefix} ${l}`;
      if (VERBOSE) console.log(line);
      this.lines.push(line);
      if (this.lines.length > 400) this.lines.shift();
    }
  }
  dump() {
    if (this.lines.length) console.error(this.lines.slice(-200).join('\n'));
  }
}
const output = new Ring();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Whitelisted environment for every child: nothing from the developer's shell leaks in. */
function childEnv(extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

function run(cmd, args, { cwd, env, prefix }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; output.push(prefix, c); });
    child.stderr.on('data', (c) => { stderr += c; output.push(prefix, c); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function killTree(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────── database / redis

let admin;      // postgres.js client on the maintenance db
let dbc;        // postgres.js client on the scratch db
let dbName;
let dbUrl;
let redis;
let dataDir;    // scratch ATTACHMENTS_DIR / BACKUP_DIR / … so the api never writes into the repo

async function createScratchDb() {
  admin = postgres(ADMIN_URL, { max: 1 });
  const stale = await admin.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'vibe_tax_sso_e2e_%'`);
  for (const r of stale) {
    log(`dropping leftover ${r.datname}`);
    await admin.unsafe(`DROP DATABASE "${r.datname}" WITH (FORCE)`);
  }
  dbName = `vibe_tax_sso_e2e_${Date.now().toString(36)}`;
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  dbUrl = u.toString();
  log(`created ${dbName}`);

  redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  await redis.flushdb();
  log(`flushed ${REDIS_URL}`);

  dataDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-tax-sso-e2e-'));
}

async function dropScratchDb() {
  if (dbc) { await dbc.end({ timeout: 5 }).catch(() => {}); dbc = null; }
  if (redis) { await redis.flushdb().catch(() => {}); redis.disconnect(); redis = null; }
  if (admin && dbName && !KEEP_DB) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch((e) => console.error('drop failed:', e.message));
    log(`dropped ${dbName}`);
  } else if (KEEP_DB) log(`kept ${dbName} (E2E_KEEP_DB=1)`);
  if (admin) { await admin.end({ timeout: 5 }).catch(() => {}); admin = null; }
  if (dataDir) { rmSync(dataDir, { recursive: true, force: true }); dataDir = null; }
}

const sql = async (text, params = []) => [...(await dbc.unsafe(text, params))];

async function auditActions() {
  return (await sql(`SELECT action, target_id, metadata, actor_user_id FROM audit_log WHERE target_type = 'auth' OR action LIKE 'auth.%' ORDER BY occurred_at, action`))
    .map((r) => ({ action: r.action, targetId: r.target_id, actor: r.actor_user_id, detail: r.metadata ?? {} }));
}
const hasAudit = (rows, action, pred = () => true) => rows.some((r) => r.action === action && pred(r));

// ─────────────────────────────────────────────────────────────── api process

let idp;
let server = null; // { child, port, base, mode }

function baseEnv() {
  return childEnv({
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    MASTER_KEY,
    JWT_SECRET,
    JWT_REFRESH_SECRET,
    DATABASE_URL: dbUrl,
    REDIS_URL,
    COOKIE_SECURE: 'false',
    TRUST_PROXY: '0',
    MIGRATIONS_AUTO: 'true',
    WORKERS_ENABLED: 'false',
    SEED_ADMIN_EMAIL: ADMIN_EMAIL,
    SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ATTACHMENTS_DIR: path.join(dataDir, 'attachments'),
    WORKSPACES_DIR: path.join(dataDir, 'workspaces'),
    DELIVERABLES_DIR: path.join(dataDir, 'deliverables'),
    BACKUP_DIR: path.join(dataDir, 'backups'),
    BACKUP_TMP_DIR: path.join(dataDir, 'backups', 'tmp'),
    SKILLS_WORKSPACE_DIR: path.join(dataDir, 'skills'),
    VIBE_BREAKGLASS_USERNAME: 'vibe-breakglass',
    ...(process.env.DB_DEBUG ? { DB_DEBUG: process.env.DB_DEBUG } : {}),
  });
}

function serverEnv(mode, port) {
  return {
    ...baseEnv(),
    PORT: String(port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
    VIBE_AUTH_MODE: mode,
    VIBE_OIDC_ISSUER: idp.issuer,
    VIBE_OIDC_CLIENT_ID: CLIENT_ID,
    VIBE_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    VIBE_OIDC_PUBLIC_URL: `http://127.0.0.1:${port}`,
  };
}

/** Boot the api in `mode`; resolves once /api/health answers (and, for SSO modes, the IdP is discovered). */
async function startServer(mode) {
  // Each boot starts a fresh rate-limit window: the password limiter is 5 per
  // 15 minutes per address and its counters live in Redis across restarts.
  await redis.flushdb();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [...TSX_IMPORT, API_ENTRY], {
    cwd: API_DIR, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => output.push(`[api:${mode}]`, c));
  child.stderr.on('data', (c) => output.push(`[api:${mode}]`, c));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    const code = await Promise.race([exited, sleep(150).then(() => null)]);
    if (code !== null) throw new Error(`api (${mode}) exited with code ${code} before becoming healthy`);
    healthy = await fetch(`${base}/api/health`).then((r) => r.status === 200).catch(() => false);
    if (healthy) break;
  }
  if (!healthy) { await killTree(child); throw new Error(`api (${mode}) did not become healthy in 90 s`); }
  if (mode !== 'local') {
    const until = Date.now() + 15_000;
    for (;;) {
      const s = await fetch(`${base}/auth/status`).then((r) => r.json()).catch(() => null);
      if (s?.oidc?.reachable) break;
      if (Date.now() > until) throw new Error(`IdP not reachable from the api: ${JSON.stringify(s)}`);
      await sleep(150);
    }
  }
  server = { child, port, base, mode };
  log(`api up (${mode}) on ${base}`);
  return server;
}

/** Boot in `mode` and expect the process to refuse; returns {code, out}. */
async function startServerExpectingRefusal(mode) {
  const port = await freePort();
  let out = '';
  const child = spawn(process.execPath, [...TSX_IMPORT, API_ENTRY], {
    cwd: API_DIR, env: serverEnv(mode, port), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (c) => { out += c; output.push(`[api:${mode}]`, c); });
  child.stderr.on('data', (c) => { out += c; output.push(`[api:${mode}]`, c); });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', (c) => resolve(c))),
    sleep(90_000).then(() => 'timeout'),
  ]);
  if (code === 'timeout') { await killTree(child); throw new Error(`api (${mode}) did not exit within 90 s`); }
  return { code, out };
}

async function stopServer() {
  if (!server) return;
  await killTree(server.child);
  log(`api stopped (${server.mode})`);
  server = null;
}

// ─────────────────────────────────────────────────────────────── http helpers

/** A "browser": cookies only. Bearer tokens travel explicitly, as the SPA sends them. */
class Browser {
  cookies = new Map();
  absorb(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of set) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*(max-age=0|expires=Thu, 01 Jan 1970)/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get at() { return this.cookies.get('vibe_at'); }
}

async function api(p, { method = 'GET', bearer, browser, json, form, headers = {} } = {}) {
  const h = { ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (browser?.cookies.size) h.cookie = browser.header();
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const res = await fetch(server.base + p, { method, headers: h, body, redirect: 'manual' });
  browser?.absorb(res);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, headers: res.headers, location: res.headers.get('location') ?? '', text, json: data, contentType: res.headers.get('content-type') ?? '' };
}

const claimsOf = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const me = (tokens) => api('/api/auth/me', { bearer: tokens.access_token });

/** Follow /auth/oidc/start → IdP (auto-consent) → callback; returns the final hop (+ the hand-off code when it landed). */
async function ssoRedirect({ returnTo } = {}) {
  let url = server.base + '/auth/oidc/start' + (returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : '');
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location') ?? '';
    if (res.status >= 300 && res.status < 400 && location) {
      if (url.includes('/auth/oidc/callback')) {
        const hash = location.split('#')[1] ?? '';
        return { status: res.status, location, code: new URLSearchParams(hash).get('sso_code'), text: '', contentType: '' };
      }
      url = new URL(location, url).toString();
      continue;
    }
    const text = await res.text();
    return { status: res.status, location, code: null, text, contentType: res.headers.get('content-type') ?? '' };
  }
  throw new Error('login redirect chain did not terminate');
}

/** The full SPA flow: redirect chain, then the one-time code exchanged for tokens. */
async function ssoLogin(opts = {}) {
  const r = await ssoRedirect(opts);
  assert.equal(r.status, 302, r.text);
  assert.ok(r.code, `no sso_code on ${r.location}`);
  const browser = new Browser();
  const ex = await api('/api/auth/sso/exchange', { method: 'POST', json: { code: r.code }, browser });
  assert.equal(ex.status, 200, ex.text);
  return { ...ex.json, browser, code: r.code, location: r.location };
}

async function localLogin(email, password) {
  const browser = new Browser();
  const r = await api('/api/auth/login', { method: 'POST', json: { email, password }, browser });
  return { ...r, tokens: r.json, browser };
}

async function breakglassCli(...args) {
  const r = await run(process.execPath, [...TSX_IMPORT, VIBE_CLI, 'breakglass', ...args, '--json'], {
    cwd: API_DIR,
    env: { ...baseEnv(), VIBE_AUTH_ADAPTER: VIBE_ADAPTER, VIBE_BREAKGLASS_PASSWORD: BREAKGLASS_PASSWORD },
    prefix: '[cli]',
  });
  assert.equal(r.code, 0, `breakglass ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  const line = r.stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  assert.ok(line, `breakglass ${args.join(' ')} printed no JSON: ${r.stdout}`);
  return JSON.parse(line);
}

// ─────────────────────────────────────────────────────────────── scenarios

let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    log(`ok   ${name}`);
  } catch (err) {
    log(`FAIL ${name}`);
    throw err;
  }
}

async function main() {
  await createScratchDb();
  idp = await new FakeIdp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, user: KURT }).start();
  log(`fake IdP at ${idp.issuer}`);

  let adminTokens;
  let patTokens;
  let patId;
  let kurtId;

  // ── Boot A: local ─────────────────────────────────────────────────────
  await startServer('local'); // runs migrations + the seed (first admin)
  dbc = postgres(dbUrl, { max: 2 });
  for (const t of ['auth_identities', 'auth_settings', 'auth_revocations', 'auth_sessions_oidc']) {
    assert.equal((await sql(`SELECT to_regclass($1)::text AS t`, [t]))[0].t, t, `migration did not create ${t}`);
  }
  assert.equal((await sql(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'auth_refresh_tokens' AND column_name = 'sid'`))[0].n, 1);

  await step('1. local mode: SSO off, start refused, password login mints a sid-less session + the vibe_at cookie', async () => {
    const s = await api('/auth/status');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.mode, 'local');
    assert.equal(s.json.oidc.enabled, false);
    assert.equal(s.json.localLoginVisible, true);
    assert.equal(s.json.breakglassPath, '/login/local');
    assert.equal((await api('/auth/oidc/start')).status, 409);
    const login = await localLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(login.status, 200, login.text);
    adminTokens = login.tokens;
    assert.ok(login.browser.at, 'vibe_at cookie expected');
    assert.equal(claimsOf(adminTokens.access_token).sid, undefined, 'a password session carries no sid');
    const m = await me(adminTokens);
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.role, 'admin');
    assert.ok(hasAudit(await auditActions(), 'auth.login.success'));
  });

  await step('fixtures: an admin creates Pat (viewer) through the admin API; Pat can sign in locally', async () => {
    const create = await api('/api/admin/users', { method: 'POST', bearer: adminTokens.access_token, json: { email: PAT_IDP.email, display_name: 'Pat', role: 'viewer', password: PAT_PASSWORD } });
    assert.ok(create.status === 200 || create.status === 201, create.text);
    patId = create.json.id ?? create.json.user?.id;
    assert.ok(patId, `no id in ${create.text}`);
    const pl = await localLogin(PAT_IDP.email, PAT_PASSWORD);
    assert.equal(pl.status, 200, pl.text);
    patTokens = pl.tokens;
  });

  await step('5. /auth/settings: 403 anonymous / viewer / cookie-only, 200 for an admin bearer; oidc_only refused without break-glass + test', async () => {
    assert.equal((await api('/auth/settings')).status, 403);
    assert.equal((await api('/auth/settings', { bearer: patTokens.access_token })).status, 403);
    const cookieOnly = new Browser();
    cookieOnly.cookies.set('vibe_at', adminTokens.access_token);
    assert.equal((await api('/auth/settings', { browser: cookieOnly })).status, 403, 'the cookie must not authenticate the settings API');
    const r = await api('/auth/settings', { bearer: adminTokens.access_token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.mode, 'local');
    assert.equal(r.json.breakglass?.exists, false);
    assert.equal(r.json.effective?.redirectUri, `${server.base}/auth/oidc/callback`);
    assert.deepEqual(r.json.roles, ['admin', 'user', 'viewer']);
    const put = await api('/auth/settings', { method: 'PUT', bearer: adminTokens.access_token, json: { mode: 'oidc_only' } });
    assert.equal(put.status, 400, put.text);
    assert.equal(put.json.error, 'validation_failed');
    const errs = put.json.errors.join(' ');
    assert.match(errs, /break-glass/);
    assert.match(errs, /Test connection/);
    assert.equal((await api('/auth/settings', { method: 'PUT', bearer: patTokens.access_token, json: { mode: 'oidc_only' } })).status, 403);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_settings'))[0].n, 0, 'a refused PUT must persist nothing');
    assert.ok(!hasAudit(await auditActions(), 'vibe.auth.mode.changed'));
  });

  await stopServer();

  // ── Boot B: oidc_only without break-glass ─────────────────────────────
  await step('11. boot is refused in oidc_only mode while no break-glass user exists', async () => {
    const { code, out } = await startServerExpectingRefusal('oidc_only');
    assert.equal(code, 1);
    assert.match(out, /break-glass user \\?"vibe-breakglass\\?" does not exist/); // pino JSON-escapes the quotes
    assert.equal((await sql(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [BREAKGLASS_EMAIL]))[0].n, 0);
  });

  // ── Boot C: both ──────────────────────────────────────────────────────
  await startServer('both');

  await step('2. status in both mode: SSO enabled and reachable; the public zone still answers', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'both');
    assert.equal(s.oidc.enabled, true);
    assert.equal(s.oidc.reachable, true);
    assert.equal(s.oidc.issuer, idp.issuer);
    assert.equal(s.oidc.startPath, '/auth/oidc/start');
    assert.equal(s.localLoginVisible, true);
    assert.equal((await api('/api/ping')).status, 200);
    assert.equal((await api('/api/health')).status, 200);
    const setup = await api('/api/setup/status');
    assert.equal(setup.status, 200);
    assert.equal(setup.json.admin_exists, true);
  });

  await step('3. PKCE login → one-time code → exchange provisions Kurt as admin; the code is single-use; return_to is honoured', async () => {
    idp.user = KURT;
    const r = await ssoRedirect();
    assert.equal(r.status, 302, r.text);
    assert.match(r.location, /^\/login#sso_code=/, r.location);
    assert.ok(idp.tokenRequests.at(-1).get('code_verifier'), 'PKCE verifier not sent');
    const [row] = await sql(`SELECT sid, user_id, oidc_sid, id_token, handoff_hash, handoff_claimed_at FROM auth_sessions_oidc ORDER BY created_at DESC LIMIT 1`);
    assert.ok(row, 'no auth_sessions_oidc row');
    assert.equal(row.handoff_claimed_at, null);
    assert.notEqual(row.handoff_hash, r.code, 'the raw code must not be stored');
    assert.equal(row.oidc_sid, 'sid-' + KURT.sub);
    assert.ok(row.id_token);
    const browser = new Browser();
    const ex = await api('/api/auth/sso/exchange', { method: 'POST', json: { code: r.code }, browser });
    assert.equal(ex.status, 200, ex.text);
    assert.ok(browser.at, 'exchange must set the vibe_at cookie (Bull Board)');
    const access = claimsOf(ex.json.access_token);
    assert.equal(access.sid, row.sid, 'the access token carries the internal sid');
    assert.equal(claimsOf(ex.json.refresh_token).sid, undefined, 'the refresh JWT never carries the sid');
    const replay = await api('/api/auth/sso/exchange', { method: 'POST', json: { code: r.code } });
    assert.equal(replay.status, 400, 'a code is single-use');
    assert.equal(replay.json.error, 'invalid_or_expired_code');
    const [u] = await sql(`SELECT id, role, is_active, display_name FROM users WHERE email = $1`, [KURT.email]);
    assert.ok(u, 'JIT user missing');
    kurtId = u.id;
    assert.equal(u.role, 'admin', 'vibe-partner must map to admin');
    assert.equal(u.is_active, true);
    assert.equal(u.display_name, 'Kurt');
    assert.equal(ex.json.user.id, kurtId);
    const m = await me(ex.json);
    assert.equal(m.status, 200, m.text);
    assert.equal(m.json.role, 'admin');
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, KURT.sub]);
    assert.equal(ident?.user_id, kurtId);
    assert.equal((await sql(`SELECT sid FROM auth_refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [kurtId]))[0].sid, row.sid, 'the refresh row carries the sid');
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.provisioned', (a) => a.targetId === kurtId), 'no provisioned audit row');
    assert.ok(hasAudit(audit, 'vibe.auth.login.success', (a) => a.targetId === kurtId), 'no package login.success audit row');
    assert.ok(hasAudit(audit, 'auth.login.success', (a) => a.actor === kurtId && a.detail.method === 'oidc'), 'no product login.success audit row for the exchange');
    const back = await ssoRedirect({ returnTo: '/research' });
    assert.match(back.location, /^\/research#sso_code=/);
    assert.equal((await api('/auth/oidc/callback?code=x&state=nope')).status, 400, 'unknown state must be refused');
  });

  await step('4. an existing local user is linked by verified email and the role is synced from the group', async () => {
    idp.user = PAT_IDP;
    const before = (await sql('SELECT count(*)::int AS n FROM users'))[0].n;
    const s = await ssoLogin();
    assert.equal(s.user.id, patId);
    assert.equal(s.user.role, 'user', 'vibe-manager must map to user');
    assert.equal((await sql('SELECT count(*)::int AS n FROM users'))[0].n, before, 'linking must not create a user');
    assert.equal((await sql('SELECT role FROM users WHERE id = $1', [patId]))[0].role, 'user');
    const [ident] = await sql(`SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2`, [idp.issuer, PAT_IDP.sub]);
    assert.equal(ident?.user_id, patId);
    const audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.user.linked', (a) => a.targetId === patId));
    assert.ok(hasAudit(audit, 'vibe.auth.role.changed', (a) => a.targetId === patId && a.detail.from === 'viewer' && a.detail.to === 'user'));
    patTokens = s;
    assert.equal((await api('/auth/settings', { bearer: patTokens.access_token })).status, 403, 'a user still cannot read settings');
  });

  await step('9. an unverified email is denied and nothing is written', async () => {
    idp.user = NOBODY;
    const r = await ssoRedirect();
    assert.equal(r.status, 401);
    assert.match(r.contentType, /text\/html/);
    assert.match(r.text, /did not confirm your email/);
    assert.equal((await sql('SELECT count(*)::int AS n FROM users WHERE email = $1', [NOBODY.email]))[0].n, 0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_identities WHERE subject = $1', [NOBODY.sub]))[0].n, 0);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.login.failure', (a) => a.detail.reason === 'unverified_email'));
  });

  await step('refresh: rotation keeps the sid on the new access token and the new row, and re-sets the cookie', async () => {
    idp.user = KURT;
    const s = await ssoLogin();
    const sid = claimsOf(s.access_token).sid;
    const browser = new Browser();
    const r = await api('/api/auth/refresh', { method: 'POST', json: { refresh_token: s.refresh_token }, browser });
    assert.equal(r.status, 200, r.text);
    assert.equal(claimsOf(r.json.access_token).sid, sid);
    assert.ok(browser.at, 'refresh must re-set vibe_at');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM auth_refresh_tokens WHERE sid = $1 AND revoked_at IS NULL`, [sid]))[0].n, 1, 'exactly one live row per chain');
    assert.equal((await api('/api/auth/refresh', { method: 'POST', json: { refresh_token: s.refresh_token } })).status, 401, 'the rotated-out refresh token is dead');
    assert.equal((await me(r.json)).status, 200);
  });

  await step('sign-out ends the SSO session at once: identity row gone, access token revoked, refresh chain dead; other sessions of the user survive', async () => {
    idp.user = KURT;
    const a = await ssoLogin();
    const b = await ssoLogin();
    const sidA = claimsOf(a.access_token).sid;
    const out = await api('/api/auth/logout', { method: 'POST', bearer: a.access_token, json: { refresh_token: a.refresh_token } });
    assert.equal(out.status, 204, out.text);
    const dead = await me(a);
    assert.equal(dead.status, 401, dead.text);
    assert.equal(dead.json.error, 'token_revoked', 'the still-valid access token must be refused by the revocation list');
    assert.equal((await api('/api/auth/refresh', { method: 'POST', json: { refresh_token: a.refresh_token } })).status, 401);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE sid = $1', [sidA]))[0].n, 0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_revocations WHERE subject_key = $1', ['s:' + sidA]))[0].n, 1);
    assert.equal((await me(b)).status, 200, 'sign-out is per session');
  });

  await step('8. back-channel logout (sub) ends every session of the user — SSO and local — once; other users keep theirs', async () => {
    idp.user = KURT;
    const a = await ssoLogin();
    const b = await ssoLogin();
    const setPw = await api(`/api/admin/users/${kurtId}/set-password`, { method: 'POST', bearer: adminTokens.access_token, json: { password: KURT_PASSWORD } });
    assert.ok(setPw.status === 200 || setPw.status === 204, setPw.text);
    const local = await localLogin(KURT.email, KURT_PASSWORD);
    assert.equal(local.status, 200, local.text);
    assert.equal((await me(a)).status, 200);
    assert.equal((await me(local.tokens)).status, 200);
    const logoutToken = await idp.logoutToken({ sub: KURT.sub, sid: 'sid-' + KURT.sub });
    const r = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE user_id = $1', [kurtId]))[0].n, 0);
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [kurtId]))[0].n, 0, 'every refresh chain of the user must be revoked');
    for (const t of [a, b, local.tokens]) {
      const m = await me(t);
      assert.equal(m.status, 401, `session must be dead: ${m.text}`);
      assert.equal(m.json.error, 'token_revoked');
      assert.equal((await api('/api/auth/refresh', { method: 'POST', json: { refresh_token: t.refresh_token } })).status, 401);
    }
    const replay = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: logoutToken } });
    assert.equal(replay.status, 400, 'a replayed logout token must be refused');
    assert.equal((await me(patTokens)).status, 200, 'logout is per user');
    assert.equal((await me(adminTokens)).status, 200, 'local sessions of other users survive');
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.logout', (a2) => a2.detail.initiated_by === 'idp'));
  });

  await step("9'. a fresh login after the back-channel logout is valid (revocation is by moment, not forever)", async () => {
    await sleep(1100); // iat has whole-second resolution
    idp.user = KURT;
    const s = await ssoLogin();
    assert.equal((await me(s)).status, 200);
  });

  await step('back-channel logout (sid only) ends just the matching session, not the user', async () => {
    idp.user = KURT;
    idp.nextSid = 'idp-sid-A';
    const a = await ssoLogin();
    idp.nextSid = 'idp-sid-B';
    const b = await ssoLogin();
    idp.nextSid = null;
    const r = await api('/auth/oidc/backchannel', { method: 'POST', form: { logout_token: await idp.logoutToken({ sid: 'idp-sid-A' }) } });
    assert.equal(r.status, 200, r.text);
    const deadA = await me(a);
    assert.equal(deadA.status, 401, deadA.text);
    assert.equal((await api('/api/auth/refresh', { method: 'POST', json: { refresh_token: a.refresh_token } })).status, 401);
    assert.equal((await me(b)).status, 200, 'the other session of the same user survives a sid-only logout');
    assert.equal((await sql('SELECT count(*)::int AS n FROM auth_sessions_oidc WHERE oidc_sid = $1', ['idp-sid-B']))[0].n, 1);
  });

  await step('10. RP-initiated logout sends the browser to the IdP and ends the session; ?local=1 lands on /login', async () => {
    idp.user = KURT;
    const s = await ssoLogin();
    const r = await api('/auth/oidc/logout', { bearer: s.access_token });
    assert.equal(r.status, 302, r.text);
    const u = new URL(r.location);
    assert.equal(u.origin, idp.base);
    assert.match(u.pathname, /\/end-session\/$/);
    assert.ok(u.searchParams.get('id_token_hint'));
    assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(u.searchParams.get('post_logout_redirect_uri'), `${server.base}/auth/oidc/logged-out`);
    assert.equal((await me(s)).status, 401);
    assert.ok(hasAudit(await auditActions(), 'vibe.auth.logout', (a) => a.detail.initiated_by === 'user'));
    const idpHop = await fetch(u.toString(), { redirect: 'manual' });
    assert.equal(idpHop.status, 302);
    const done = await fetch(idpHop.headers.get('location'), { redirect: 'manual' });
    assert.equal(done.status, 200);
    assert.match(done.headers.get('content-type') ?? '', /text\/html/);
    assert.match(done.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/, 'engine pages get their own CSP');
    const again = await ssoLogin();
    const local = await api('/auth/oidc/logout?local=1', { bearer: again.access_token });
    assert.equal(local.status, 302);
    assert.equal(local.location, '/login');
    assert.equal((await me(again)).status, 401);
    // A cookie-only navigation must NOT be able to log anyone out (logout-CSRF).
    const victim = await ssoLogin();
    const csrf = await api('/auth/oidc/logout?local=1', { browser: victim.browser });
    assert.equal(csrf.status, 302);
    assert.equal((await me(victim)).status, 200, 'the cookie alone must not end a session');
  });

  await step('test-connection popup: POST /auth/settings/test refreshes vibe_at, and the popup navigation authenticates by cookie only there', async () => {
    const browser = new Browser();
    const t = await api('/auth/settings/test', { method: 'POST', bearer: adminTokens.access_token, json: {}, browser });
    assert.equal(t.status, 200, t.text);
    assert.match(t.json.url, /^\/auth\/oidc\/start\?/);
    assert.ok(browser.at, 'settings/test must re-set the vibe_at cookie for the popup');
    const popup = await api(t.json.url, { browser });
    assert.equal(popup.status, 302, popup.text);
    assert.equal(new URL(popup.location).origin, idp.base);
    assert.equal(new URL(popup.location).searchParams.get('prompt'), 'login');
    assert.equal((await api(t.json.url)).status, 403, 'the test start needs an admin');
    const viewerCookie = new Browser();
    viewerCookie.cookies.set('vibe_at', patTokens.access_token);
    assert.equal((await api(t.json.url, { browser: viewerCookie })).status, 403);
  });

  await step('7. the break-glass CLI (the image command) provisions an admin who can sign in locally; both are audited', async () => {
    const created = await breakglassCli('ensure');
    assert.equal(created.status, 'created', JSON.stringify(created));
    assert.equal(created.username, 'vibe-breakglass');
    const [bg] = await sql(`SELECT id, role, is_active, email FROM users WHERE email = $1`, [BREAKGLASS_EMAIL]);
    assert.ok(bg, 'break-glass user row missing');
    assert.equal(bg.role, 'admin');
    assert.equal(bg.is_active, true);
    let audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.rotated'), 'no breakglass.rotated audit row');
    const login = await localLogin(BREAKGLASS_EMAIL, BREAKGLASS_PASSWORD);
    assert.equal(login.status, 200, login.text);
    audit = await auditActions();
    assert.ok(hasAudit(audit, 'vibe.auth.breakglass.used', (a) => a.targetId === bg.id), 'no breakglass.used audit row');
    assert.equal((await me(login.tokens)).json.role, 'admin');
    const again = await breakglassCli('ensure');
    assert.equal(again.status, 'exists', 'ensure must be idempotent');
    const st = await breakglassCli('status');
    assert.equal(st.exists, true);
    assert.equal(st.active, true);
    assert.equal(st.role, 'admin');
    const settings = await api('/auth/settings', { bearer: login.tokens.access_token });
    assert.equal(settings.status, 200, settings.text);
    assert.equal(settings.json.breakglass.exists, true);
  });

  await stopServer();

  // ── Boot D: oidc_only with break-glass ────────────────────────────────
  await startServer('oidc_only');
  await step('oidc_only: only the break-glass admin may use a password; SSO start and the public zone still answer', async () => {
    const s = (await api('/auth/status')).json;
    assert.equal(s.mode, 'oidc_only');
    assert.equal(s.localLoginVisible, false);
    const refused = await localLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.error, 'local_login_disabled');
    const bg = await localLogin(BREAKGLASS_EMAIL, BREAKGLASS_PASSWORD);
    assert.equal(bg.status, 200, bg.text);
    assert.equal((await api('/auth/oidc/start')).status, 302);
    assert.equal((await api('/api/ping')).status, 200);
    assert.equal((await api('/api/setup/status')).status, 200);
    idp.user = KURT;
    assert.equal((await me(await ssoLogin())).status, 200, 'SSO login still works in oidc_only');
  });
  await stopServer();
}

// ─────────────────────────────────────────────────────────────── lifecycle

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stopServer().catch(() => {});
  if (idp) await idp.stop().catch(() => {});
  await dropScratchDb().catch((e) => console.error('cleanup:', e.message));
}

process.on('exit', (code) => { process.stderr.write(`sso-e2e: exiting with code ${code} after ${passed} passed steps\n`); });

const watchdog = setTimeout(() => {
  console.error('sso-e2e: watchdog fired after 600 s');
  output.dump();
  cleanup().finally(() => process.exit(1));
}, 600_000);
watchdog.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { cleanup().finally(() => process.exit(1)); });
}

// Let stdout drain before leaving (process.exit right after console.log can drop
// the last lines when stdout is a pipe). Everything is closed by cleanup().
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

main()
  .then(async () => {
    await cleanup();
    log(`ALL ${passed} STEPS PASSED`);
    finish(0);
  })
  .catch(async (err) => {
    console.error(err);
    output.dump();
    await cleanup();
    finish(1);
  });
