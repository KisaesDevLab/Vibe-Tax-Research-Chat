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
