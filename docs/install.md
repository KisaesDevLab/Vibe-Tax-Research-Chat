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

## Troubleshooting

| Symptom                                | Fix                                                              |
| -------------------------------------- | ---------------------------------------------------------------- |
| `docker compose up` exits with 1       | Check `docker compose logs <service>`                            |
| Wizard reports "key validation failed" | Re-check the key; confirm outbound HTTPS to api.anthropic.com    |
| `/api/health/deep` returns 503         | One of `db` / `redis` is down: `docker compose ps`               |
| Skills sync says "no changes" forever  | Check `SKILLS_REPO_PIN_VALUE` and that the repo URL is reachable |
