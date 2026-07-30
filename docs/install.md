# Install — Vibe Tax Research Chat

Production install on a single Linux box (Ubuntu 24.04 LTS, GMKtec NucBox M6 / equivalent
mini-PC). Should take under 30 minutes.

## 1. Prerequisites

- Ubuntu 24.04 LTS (server or desktop both fine)
- 16+ GB RAM, 4+ cores, 256+ GB SSD
- A static LAN IP or Tailscale-assigned IP
- Anthropic API key (`sk-ant-…`)

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out and back in, then:
docker --version
docker compose version
```

## 3. Clone the repo

```bash
git clone https://github.com/KisaesDevLab/Vibe-Tax-Research-Chat.git
cd Vibe-Tax-Research-Chat
```

## 4. Generate secrets and create `.env`

```bash
cp .env.example .env
sed -i "s/^MASTER_KEY=.*/MASTER_KEY=$(openssl rand -hex 32)/" .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 64)/" .env
sed -i "s/^JWT_REFRESH_SECRET=.*/JWT_REFRESH_SECRET=$(openssl rand -hex 64)/" .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
```

Optional but recommended:

```bash
sed -i "s|^GITHUB_WEBHOOK_SECRET=.*|GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)|" .env
```

## 5. Bring up the stack

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec api pnpm db:migrate:prod
docker compose -f docker-compose.prod.yml exec api pnpm db:seed:prod
```

The stack now includes five services: `postgres`, `redis`, `api`, `web`,
and `authority-mcp` (Phase 34 — appliance-side tax-authority cache for
USC and CFR lookups; the api will start consulting it when Phase 36's
per-source `web_resource_strategy` flag flips it on for a given source).
`authority-mcp` shares the same Postgres as the api and is not exposed
to the host — the api reaches it at `http://authority-mcp:4100` over the
docker network.

> The `:prod` variants run the compiled `dist/migrate.js` / `dist/seed.js`
> directly with `node`. The plain `pnpm db:migrate` alias goes through
> `tsx src/migrate.ts`, which is fine for local development but won't
> work inside the runtime image (it ships only `dist/`, not `src/`).

## 6. First-run wizard

Open `http://<box-ip>/setup` in a browser. Three steps:

1. Create the admin account.
2. Paste the Anthropic API key (validated with a 1-token Haiku call before storage).
3. Pick the default model (Sonnet 4.6 recommended). Initial skills sync is queued.

When you're done, you're on `/chat` with one chat to start.

## 7. (Optional) Tailscale + Cockpit / Portainer

If you want LAN-wide access without exposing port 80 to the internet:

```bash
# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# now reach the box at http://<tailnet-name>.ts.net
```

Cockpit and Portainer are both compatible — the appliance binds to port 80 only and uses
no special hostnames.

### Putting your own TLS terminator in front

If you front the bundled web container with a separate HTTPS proxy (Tailscale Serve,
Caddy on the same host, a hardware load balancer), the included nginx in the
`web` container forwards `X-Forwarded-Proto: $scheme` — i.e., the scheme of the
nginx-side connection, which is `http` from your TLS proxy. The API will see
HTTP and won't issue `Secure` cookies, which the browser then drops on the
HTTPS origin. Force the cookie attribute on by adding to `.env`:

```sh
COOKIE_SECURE=true
```

Restart the api container after the change.

## 8. (Optional) Backups

`scripts/backup.sh` runs `pg_dump` + gzip into `./backups/`. Wire it into cron:

```bash
crontab -e
# nightly at 02:30
30 2 * * * cd /home/$USER/Vibe-Tax-Research-Chat && BACKUP_DIR=$PWD/backups bash scripts/backup.sh
```

If `DUPLICATI_TARGET` is set, the script forwards to your Duplicati endpoint (S3, B2, SFTP).
See `docs/admin-guide.md#backup--restore` for restore steps.

## 9. Updating

```bash
cd Vibe-Tax-Research-Chat
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec api pnpm db:migrate:prod
```

### Upgrading from a pre-v1.5 install (`postgres:16-alpine` → `pgvector/pgvector:pg16`)

v1.5 introduces the firm reference library (Phase 32), which requires the `vector`
PostgreSQL extension. The compose file pins `pgvector/pgvector:pg16` instead of
`postgres:16-alpine`. Both share the standard PostgreSQL 16 PGDATA layout, so
the existing `postgres_data` volume migrates transparently:

```bash
docker compose -f docker-compose.prod.yml down                    # stop the stack
docker compose -f docker-compose.prod.yml pull postgres           # pull pgvector image
docker compose -f docker-compose.prod.yml up -d                   # boot with new image
docker compose -f docker-compose.prod.yml exec api pnpm db:migrate:prod
                                                                  # 0002_reference_pgvector
                                                                  # creates the extension
```

The migration is idempotent (`CREATE EXTENSION IF NOT EXISTS vector`). Customers who
don't intend to use the firm reference library can leave `EMBEDDINGS_API_KEY` unset —
chat works without it; only the admin's "Reference Library" page is gated.

## 10. (Optional) Embeddings — firm reference library

Skip this section if you don't plan to upload firm-internal research memos.

Set a Voyage AI key in `.env` so the ingest worker can chunk + embed uploaded
documents:

```sh
EMBEDDINGS_PROVIDER=voyage
EMBEDDINGS_MODEL=voyage-3-large
EMBEDDINGS_API_KEY=vk-xxxxxxxxxxxxxxxxxx
```

Issue a key at `https://dash.voyageai.com/`. Cost is ~$0.18 per 1M input tokens —
a 50-page memo runs about $0.01 to embed. Restart the api container after adding
the key. The admin "Reference Library" page handles upload, status tracking,
re-ingest on transient failures, and a "Test retrieval" tool for sanity-checking
the pipeline.

## Troubleshooting

| Symptom                                                          | Fix                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docker compose up` exits with 1                                 | Check `docker compose logs <service>`                                                       |
| Wizard reports "key validation failed"                           | Re-check the key; confirm outbound HTTPS to api.anthropic.com                               |
| `/api/health/deep` returns 503                                   | One of `db` / `redis` is down: `docker compose ps`                                          |
| `/api/ping` works but `/api/health/deep` doesn't                 | Process is up; DB or Redis is degraded. Check container logs.                               |
| Skills sync says "no changes" forever                            | Check `SKILLS_REPO_PIN_VALUE` and that the repo URL is reachable                            |
| Cookies not set when behind a proxy                              | Confirm the proxy sends `X-Forwarded-Proto`; bump `TRUST_PROXY` if there are multiple hops. |
| Reference upload stays "queued" forever                          | Workers aren't running, or the queue is stuck. Check `/admin/queues` (Bull Board).          |
| Reference goes to "failed" with "EMBEDDINGS_API_KEY is required" | Set `EMBEDDINGS_API_KEY` in `.env` and restart the api container.                           |
| Reference goes to "failed" with "parsed text is empty"           | Document is a scanned PDF or unsupported format. OCR upstream first.                        |

## Appliance mode (Vibe-Appliance suite)

Vibe Tax Research Chat also runs as a sub-app of the
[Vibe-Appliance](https://github.com/KisaesDevLab/Vibe-Appliance) multi-app stack
alongside other Vibe apps (MyBooks, Trial Balance, etc.). In appliance mode this
app shares the parent's Postgres, Redis, and Caddy — it does **not** bring its
own. The Anthropic API key is still entered by the firm admin via the in-app
`Admin → Settings` flow after first login (same as standalone).

### What's different from standalone

| Concern              | Standalone (`docker-compose.prod.yml`)                                                                                                | Appliance (`docker-compose.appliance.yml`)                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Postgres             | Bundled `postgres:16-alpine` service                                                                                                  | Shared, supplied via `VIBE_TAX_DATABASE_URL`                         |
| Redis                | Bundled `redis:7-alpine` service                                                                                                      | Shared, supplied via `VIBE_TAX_REDIS_URL`                            |
| Reverse proxy        | Local `web` container on port 80                                                                                                      | Parent Caddy at `tax.<domain>` and HAProxy emergency :5191           |
| Migrations + seed    | API auto-runs migrations + seed at startup (image default `MIGRATIONS_AUTO=true`); set `false` to run `pnpm db:migrate:prod` yourself | Same, set explicitly by the manifest                                 |
| CORS                 | Single `PUBLIC_BASE_URL`                                                                                                              | List via `VIBE_TAX_ALLOWED_ORIGIN` (primary + Tailscale + emergency) |
| Cookie `Secure` flag | NODE_ENV-driven                                                                                                                       | `COOKIE_SECURE=auto` — set per request based on `req.secure`         |

### Required appliance env (set by the appliance bootstrapper)

```sh
VIBE_TAX_DATABASE_URL=postgres://vibetax:<password>@postgres:5432/vibe_tax
VIBE_TAX_REDIS_URL=redis://redis:6379
VIBE_TAX_ALLOWED_ORIGIN=https://tax.firm.com,https://tax.tailnet-x.ts.net,http://192.168.1.42:5191
VIBE_TAX_MASTER_KEY=<hex32>
VIBE_TAX_JWT_SECRET=<hex64>
VIBE_TAX_JWT_REFRESH_SECRET=<hex64>
VIBE_TAX_TAG=latest          # or a pinned vX.Y.Z
```

### Bring it up under the parent stack

```bash
docker compose \
  -f /opt/vibe/compose.yml \
  -f /opt/vibe/apps/vibe-tax-research/docker-compose.appliance.yml \
  up -d vibe-tax-api vibe-tax-web
```

The parent's bootstrapper handles this automatically when the operator selects
"Tax Research" in the appliance install wizard. The `.appliance/manifest.json`
in this repo describes the env, ports, and emergency-port assignment so the
parent knows how to wire it in.

### After the stack is up

1. Browse to `https://tax.<your-domain>` (Caddy primary) or
   `https://tax.<tailnet>.ts.net` (Tailscale) and log in.
2. First registered user becomes the firm admin.
3. Paste the firm's Anthropic API key in `Admin → Settings`. The key is
   AES-256-GCM encrypted with `MASTER_KEY` and validated via a 1-token Haiku
   call before storage.
4. Pick the default model. Initial skills sync queues automatically.

### Emergency access

If primary access is broken (Caddy down, DNS down, ISP outage), reach the app
at `http://<lan-ip>:5191/` over plain HTTP. The HAProxy emergency-proxy front
on port 5191 is part of the parent appliance, not this app. Cookies issued by
this app over plain HTTP will not have the `Secure` flag (per
`COOKIE_SECURE=auto`), so the session works without a TLS terminator.
