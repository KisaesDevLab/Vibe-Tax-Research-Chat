# Admin guide

This appliance has one admin role and one normal user role. The admin manages everything;
users send chats. There is no separate "owner" tier.

## API key rotation

Admin → Settings → Anthropic API key → **Rotate**.

- Paste the new `sk-ant-…` key.
- The appliance validates it with a 1-token Haiku 4.5 call before storing.
- The new key replaces the old one immediately. In-flight chats use the old key until they
  finish; the next turn picks up the new key.
- Both old and new key writes are recorded in `audit_log`.

## Model rate edits

Admin → Models. Every cell in the table is editable. **The new rate applies to the next chat
turn**; in-flight turns are unaffected.

To pull the bundled upstream rate card:

1. Click **Refresh from upstream**.
2. Inspect the diff in the yellow pending-changes box.
3. Click **Apply**.

Roll back by editing the rates manually — there is no automatic rollback.

## User lifecycle

Admin → Users.

| Action       | Endpoint                                           | Notes                                      |
| ------------ | -------------------------------------------------- | ------------------------------------------ |
| Invite       | `POST /api/admin/users`                            | One-time password; reset after first login |
| Disable      | `PATCH /api/admin/users/:id is_active=false`       | Login blocked, chats preserved             |
| Spend cap    | `PATCH /api/admin/users/:id monthly_spend_cap_usd` | Hard cap; turns blocked when exceeded      |
| Set password | `POST /api/admin/users/:id/set-password`           | Admin sets a new password directly         |
| Soft-delete  | `DELETE /api/admin/users/:id`                      | `deleted_at` set; audit history preserved  |

## Backup & restore

### Moving an install to another server (Admin → Backup & restore)

The in-app path needs no shell and is the one to use when relocating a firm
to new hardware. **Admin → Backup & restore** produces a single encrypted
file (`.vtbk`) containing everything:

| Included                       | Notes                                              |
| ------------------------------ | -------------------------------------------------- |
| Full `pg_dump` of the database | Clients, plans, chats, strategies, settings, audit |
| `attachments/`                 | Uploaded documents and reference library files     |
| `storage/deliverables/`        | Rendered plan PDFs                                 |
| `workspaces/`                  | Cloned skills repo and scratch                     |
| `MASTER_KEY`                   | So encrypted settings still decrypt on the new box |

The archive is AES-256-GCM encrypted with a key derived from a passphrase
you choose (scrypt). **There is no recovery if the passphrase is lost** —
nothing on the server can open the file afterwards. Because it carries
`MASTER_KEY` plus every client record, treat the file itself as a
credential.

To move a server:

1. On the **old** server: Admin → Backup & restore → set a passphrase →
   _Create and download backup_.
2. Stand up the new server and complete first-run setup.
3. On the **new** server: Admin → Backup & restore → choose the file, enter
   the passphrase, type `REPLACE` → _Restore from backup_.
4. Restart the API container so the restored settings are read fresh.

If the new server's `MASTER_KEY` differs from the archive's, the restore
result says so and prints the key to set. Until it matches, the stored
Anthropic key and SMTP password cannot be decrypted — everything else
restores normally.

**Prerequisite on the destination: the `vector` extension must already
exist.** Installing it requires superuser, which a shared-database
appliance role does not have. Restore checks this _before_ running anything
destructive and stops with instructions if it is missing, so a failed
attempt costs nothing:

```sql
-- as a superuser, on the destination database
CREATE EXTENSION vector;
```

### Restoring offline (recommended for a server move)

Restoring through the browser competes with the running app: a reverse
proxy can time out the request, and the app's own connections hold locks on
the tables being replaced. With the API stopped, none of that applies. Copy
the archive to the destination server and:

```bash
docker cp backup.vtbk vibe-tax-api:/tmp/backup.vtbk
docker stop vibe-tax-api                      # no traffic, no locks
docker run --rm   --network <appliance network>   --env-file /opt/vibe/env/vibe-tax-research.env   -v /tmp:/work   -e BACKUP_PASSPHRASE='…'   ghcr.io/kisaesdevlab/vibe-tax-api:latest   node apps/api/dist/lib/backup/cli.js /work/backup.vtbk
docker start vibe-tax-api
```

The exit code is the real outcome, and the output says plainly whether
anything was changed on failure. If the destination's `MASTER_KEY` differs
from the archive's, it prints the key to set.

Restoring **replaces** the database and data directories on the target. The
database is loaded with `ON_ERROR_STOP=1`, so a bad archive fails loudly
rather than leaving a half-restored install, and files are staged to a
temporary directory and swapped in only after the database load succeeds.

The client major is matched to the server major automatically (the image
ships both), because a `pg_dump` 17 dump cannot be loaded into PostgreSQL
16 — it writes a `transaction_timeout` setting that 16 rejects.

### Scheduled host-side dumps

For unattended nightly backups the shell path still applies and is
complementary to the above.

Backup: `scripts/backup.sh` — `pg_dump | gzip` into `./backups/`. Cron from the host.

Restore on a fresh appliance:

```bash
docker compose -f docker-compose.prod.yml up -d postgres redis
pnpm tsx scripts/restore.ts ./backups/vibe-2026-04-27.sql.gz
docker compose -f docker-compose.prod.yml up -d
```

The restore script:

1. `FLUSHALL` on Redis (drains queues + rate limit + cached sessions).
2. Drops + recreates `vibe_tax`.
3. `gunzip | psql` the tarball.
4. Runs `node packages/db/dist/migrate.js` inside the api container to catch any schema added since the backup.
5. Queues a skills sync dry-run so you can re-acknowledge any drift.

## Skills sync

Admin → Skills → **Sync from upstream**.

- Produces a dry-run diff. Nothing is uploaded yet.
- Click **Apply** to upload changed skills to the customer's Anthropic workspace and write
  `skill_versions` rows.
- Rollback per skill: pick a prior version row → **Make current**.

Nightly cron (03:00) runs a dry-run and surfaces an "Updates available" badge on the
dashboard if changes are pending. Webhook receiver at `/api/webhooks/github` (HMAC-verified)
queues an immediate dry-run on push.

## Audit log

Every admin action is written to `audit_log`. Currently no UI; query via SQL:

```sql
SELECT occurred_at, action, target_type, target_id, metadata
FROM audit_log
WHERE actor_user_id = '…'
ORDER BY occurred_at DESC LIMIT 100;
```

UI in v1.5.

## Bull Board (queues)

Admin-only at `/admin/queues`. Shows queue depth, in-flight jobs, failures, retries for:

- `skills:sync` — dry-runs from cron and webhooks
- `skills:ingest` — first-time ingestion
- `chat:title` — Haiku auto-titler
- `usage:rollup` — hourly materialized-view refresh
- `attachment:summarize` — async PDF/DOCX summarizer
- `notifications:email` — admin email alerts (TODO)
