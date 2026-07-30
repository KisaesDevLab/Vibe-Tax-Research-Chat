# Deployment checklist — Planning module (TP-15)

Everything the appliance operator confirms before (and right after) turning on
`planning_enabled` for a firm. Items marked **external** depend on infrastructure that is
not part of this repo; the app degrades gracefully while they are absent, but the
checklist is the single place they are tracked.

## 1. Secrets & keys

- [ ] `MASTER_KEY` set (32-byte hex) and backed up in the firm's secret store. Losing it
      orphans every encrypted setting (Anthropic key, SMTP password).
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` set and **different from each other**.
- [ ] `LINK_SIGNING_SECRET` set (≥16 chars). Rotating it invalidates every outstanding
      signed deliverable link — rotate deliberately.
- [ ] Anthropic API key entered via Admin → Settings (encrypted at rest; never in env).
- [ ] `ANTHROPIC_KILL_SWITCH` understood by the on-call operator: setting it to `1`
      instantly blocks all Claude traffic (streaming + jobs) without touching the key.

## 2. Anthropic account (external)

- [ ] **ZDR**: zero-data-retention is an _organization-level_ agreement with Anthropic —
      confirm the org serving this key has it. There is no per-request header.
- [ ] **Shield egress** (optional): if the firm routes LLM traffic through a Shield
      proxy, set `SHIELD_URL` and verify a chat round-trip; confirm the egress policy
      allowlists only `api.anthropic.com`.
- [ ] Model availability: the pinned models in `apps/api/src/lib/anthropic/jobs-config.ts`
      exist for this org (chat models are managed in Admin → Models).

## 3. Network (external)

- [ ] Tailscale (or the firm's VPN) fronts the appliance; the only public listener is the
      reverse proxy. Signed deliverable links (`/api/dl/:token`) are the ONLY route meant
      for client-facing exposure — confirm the proxy exposes nothing else unauthenticated.
- [ ] CORS: `ALLOWED_ORIGIN` covers every hostname staff actually use.

## 4. Database & backups

- [ ] Migrations 0000–0012 applied (`pnpm db:migrate`); verify the 0012 triggers exist:
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('plan_results_freeze','audit_log_append_only');`
- [ ] Seed run twice — second run must insert 0 strategy versions (idempotency proof).
- [ ] Nightly `scripts/backup.sh` cron in place (`BACKUP_MODE=compose` in docker,
      `BACKUP_MODE=local` + libpq vars otherwise).
- [ ] **Restore drill performed on this install** (not just in CI): restore the latest
      dump into a scratch database, confirm strategy/golden/audit counts and that the
      0012 triggers still raise. The TP-15 drill procedure is in `STATE.md` notes.
- [ ] **Offsite** (external): Vault/B2 (or the firm's equivalent) receives the dumps —
      `DUPLICATI_TARGET` hook or an external sync job. Verify at least one offsite
      restore before go-live.
- [ ] `DELIVERABLES_DIR` and `attachments/` are on backed-up storage (pg_dump does NOT
      cover them).

## 5. Engagement integrations (external, optional)

- [ ] OpenSign: `OPENSIGN_BASE_URL` + `OPENSIGN_API_KEY` + `OPENSIGN_WEBHOOK_SECRET`;
      webhook pointed at `/api/webhooks/opensign`. Absent → staff use the manual
      override (admin-only, audited).
- [ ] Stripe: `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`; webhook pointed at
      `/api/webhooks/stripe` with `invoice.paid` events. Absent → manual override.
- [ ] Webhook endpoints are reachable from the provider (they sit OUTSIDE auth by
      design; signatures are the gate).

## 6. Rendering

- [ ] Deliverables render server-side via PDFKit (the same engine as chat exports) —
      no browser, no extra image layers. Smoke: generate an advisor PDF on a test plan
      (multi-page output: cover + projection + one page per strategy).

## 7. Jobs

- [ ] Redis reachable; Bull Board (`/admin/queues`) shows the cron rows:
      `cron-skills-sync-nightly`, `cron-usage-rollup-hourly`, `cron-tables-draft-annual`,
      `cron-strategy-watch-weekly`, `cron-archive-scan-weekly`.
- [ ] With no Anthropic key: tables-draft / strategy-watch / strategy-author /
      strategy-refresh log a skip and succeed (expected idle mode). golden-regression
      and archive-scan run regardless.
- [ ] Review queue (`/admin/review-queue`) is checked by a named owner on a cadence —
      the pipeline never publishes anything without a decision there.

## 8. Go-live gates

- [ ] `planning_enabled` flipped for the firm; non-planning users see zero change.
- [ ] One full dry-run on production hardware: client → intake → plan → compute →
      review gate (blocked → linked → passes) → present → freeze verified (409) →
      advisor PDF → signed link download → engagement (webhook fixtures or manual
      override) → names unlocked in the client PDF.
- [ ] `plan_memos_enabled` left OFF unless the firm has opted into Claude-drafted memos.
