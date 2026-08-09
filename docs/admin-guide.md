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

## Backup & restore (disaster recovery)

### What a backup is

**Admin → Backup & restore → Create backup** builds a single encrypted
archive (`.vtbk`, format 2) **on the server**, in the backups volume. It
contains everything a replacement server needs:

| Included                      | Notes                                              |
| ----------------------------- | -------------------------------------------------- |
| `pg_dump -Fc` of the database | Users, clients, plans, chats, settings, audit      |
| `attachments/`                | Uploaded documents and reference library files     |
| `storage/deliverables/`       | Rendered plan PDFs                                 |
| `workspaces/`                 | Cloned skills repo and scratch                     |
| `MASTER_KEY`                  | So encrypted settings still decrypt on the new box |
| Verification manifest         | Per-table row counts taken at the dump's snapshot  |

The archive is AES-256-GCM encrypted with a key derived (scrypt) from a
passphrase you choose. **There is no recovery if the passphrase is lost.**
Because the file carries `MASTER_KEY` plus every client record, treat it as
a credential.

Backups are **manual**: create one before risky changes and on a cadence
you choose, then **Download** it off the server — your recovery point is
the newest archive you can still reach when the machine is gone. Archives
remain listed on the page (download/delete) until you remove them.

Not included, by design: Redis contents (queued jobs and rate-limit
windows are transient) and the CDN-redownloadable model/skills caches.

### Restoring

Restore from **Admin → Backup & restore** (upload a `.vtbk` or pick a
retained archive), from **first-run setup** on a fresh install (the wizard
offers "Restore from backup" while no admin exists), or from the offline
CLI. All three run the same engine:

1. **inspect** — the manifest is read; incompatible archives (newer app
   version, newer PostgreSQL dump) are refused before anything runs.
2. **prepare** — a scratch database is created. Privilege problems stop
   here; the live install is untouched.
3. **extract / load** — the archive is decrypted (integrity-verified) and
   `pg_restore`d into the scratch database. Progress is visible phase by
   phase; a load that produces no activity for 5 minutes is killed and
   reported with the PostgreSQL activity snapshot — a restore can be slow,
   but it can never silently hang.
4. **verify** — row counts are compared against the manifest and the
   restored data must contain an active admin. Any mismatch aborts with
   the live install untouched.
5. **swap** — the databases and data directories are exchanged by rename.
   This is the only moment the install changes, it takes seconds, and
   every step is journaled: a crash mid-swap is completed automatically at
   the next start.
6. **finalize** — migrations run (older archives are upgraded forward),
   and the previous generation is kept for rollback.

After a successful restore, **restart the api container** and sign in with
the credentials from the server the backup came from. If the archive's
`MASTER_KEY` differs from this server's, the result says so and shows the
key to set — until it matches, the stored Anthropic key and SMTP password
cannot be decrypted.

**Rollback**: until the next restore, the previous database and files are
retained; _Roll back to the previous generation_ (or `vibe-backup
rollback`) swaps them back in seconds.

Format-1 archives (created before DR v2) are not restorable by this
release — restore them on the release that created them, then create a
fresh backup.

### Offline CLI

For automation, or when the app itself is the problem:

```bash
docker compose exec api vibe-backup list
docker compose exec -e BACKUP_PASSPHRASE='…' api vibe-backup inspect vibe-tax-backup-<stamp>.vtbk
docker compose exec -e BACKUP_PASSPHRASE='…' api vibe-backup restore vibe-tax-backup-<stamp>.vtbk
docker compose exec api vibe-backup rollback
docker compose exec api vibe-backup recover     # complete/clean an interrupted restore
```

`restore` follows the journal and prints each phase; the exit code is the
real outcome. A file path outside the backups volume works too (mount it
into the container first).

### RTO / RPO

- **RPO** — the age of the newest archive you can reach. Backups are
  manual; download after every backup and back up before risky changes.
- **RTO** — install the appliance, then first-run restore: dominated by
  archive upload + `pg_restore` time, both visible phase by phase. The
  swap itself is seconds, and a failed restore before the swap costs
  nothing.

### Restore drill

A backup nobody has restored is a hope, not a plan. `scripts/dr-e2e.sh`
runs the full loop against a disposable compose stack (bootstrap → create
backup → destroy volumes → first-run restore → sign in with the original
credentials); run it after upgrades that touch the schema or storage.

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
