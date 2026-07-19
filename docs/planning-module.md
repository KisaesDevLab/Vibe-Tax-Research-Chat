# Planning module — operator guide (TP-16)

The Planning + Clients modules turn the research appliance into a tax-planning
workbench: a deterministic engine, a 100-strategy library, client plans with a
partner review gate, rendered deliverables, and an engagement loop. This guide is
for the appliance operator/admin. The build log lives in `STATE.md`; applied
defaults in `QUESTIONS.md`; go-live gates in `docs/deployment-checklist.md`.

## 1. Turning it on

Planning is off by default and invisible to users. Enable per install:

- Setting `planning_enabled` (Admin → Settings, or seed + SQL). Off = the research
  app behaves exactly as before; every `/api/planning/*` and `/api/clients/*` route
  404s behind the flag.

## 2. First principles (what the system will and won't do)

- **The engine does the math; Claude never computes tax.** Plans are computed by
  `@vibe/engine` from a versioned table set. Claude drafts prose (titles, memos,
  strategy drafts) and always lands in a review queue or behind a DRAFT label.
- **Everything is pinned.** A computed plan stores `{table_set_id, engine_version,
strategy_versions}`. Publishing new content or tables never changes an issued plan;
  DB triggers (migration 0012) make frozen results and the audit log immutable.
- **Nothing publishes without a human.** Pipeline output (strategy drafts, table
  drafts, watch hits, golden failures, archive-scan hits) goes to Admin → Review
  queue. Approval is the only path to `current_version_id`.

## 3. Table sets

- Versioned tax constants per year (`table_sets`), seeded with a verified 2026 set.
- View: Admin → Table sets. Publish: `POST /api/admin/table-sets/:id/publish` —
  publishing automatically re-runs all golden tests against the new set
  (`golden-regression`); drift lands in the review queue with per-case deltas.
- Drafting next year: the `tables-draft` job (cron Oct 1, or run on demand from
  Bull Board) asks Claude for a field-by-field draft with source URLs; the diff
  panel shows every changed leaf. No Anthropic key → the job idles.

## 4. Strategy library

- 100 records ship seeded (56 modeled with apply modules + 112 engine-computed
  golden tests; 44 advisory with suggest rules). Content lives in
  `packages/strategies/content/` and seeds idempotently.
- Validation gates (schema, citation lint, prose reading-level + banned words,
  completeness) run in `pnpm test` and in the authoring pipeline; see
  `docs/strategy-schema.md`.
- Refresh pipeline: `POST /api/admin/strategies/:id/draft` (or the
  `strategy-refresh` queue) has Claude draft an updated record → validators → one
  retry → draft version + review-queue item. Drafts that touch the MATH (module
  ref, applyOrder, inputs) are flagged `needs_module_change` — approving the queue
  item alone cannot ship a math change; a TS module change must ship with it.
- Weekly `strategy-watch` (Claude + web search over each record's monitoring
  block, 180-day dedup) and `archive-scan` (local keyword match against the firm's
  archived research) feed the same queue. A heartbeat audit row proves the watch
  ran even when quiet.

## 5. Clients & research archives

- Clients are local-only records (no T&B sync yet — additive migration later).
- Research chats can be archived to a client: PII detector + one-click redaction,
  content-addressed snapshot (sha256), full-text search, retention tombstones.
- Archiving FROM a plan's "Research this" launcher with the plan selected creates
  the plan↔archive research link automatically — that link is what the elevated-
  risk review gate checks.

## 6. Plan lifecycle

draft → in-review → presented → engaged → delivered → archived
(back-edge: in-review → draft only)

- **Intake**: typed profile form, or 1040 PDF import (coordinate extraction with
  per-vendor anchor overrides; staff confirm a tie-out screen before anything
  applies; OCR is a stub seam).
- **Scenarios**: strategy selections with per-strategy params; compute writes
  pinned results for baseline + each scenario across the projection years.
- **Review gate** (in-review → presented): every checklist item ticked, reviewer
  assigned and ≠ preparer, and every selected elevated-risk strategy linked to an
  active archived research session. The transition endpoint enforces it; the UI
  mirrors it.
- **Freeze**: at presented and beyond, computes/profile edits return
  409 `plan_frozen`, and the 0012 DB trigger enforces the same invariant against
  any writer.

## 7. Deliverables & delivery

- Kinds: advisor-pdf, client-pdf, handout, pitch-deck (names hidden until
  engaged), slideshow. Rendered server-side by PDFKit (`pdf-render` queue) —
  the same engine chat exports use; real selectable text, no browser
  dependency — stored content-addressed under `DELIVERABLES_DIR`. The staff
  slideshow "present" mode is a live HTML view, not an artifact.
- Client-facing kinds require plan ≥ presented AND entitlement: without
  `LICENSING_URL`/`LICENSE_KEY` the internal kinds fail open, client-facing kinds
  fail closed (402 `license_required`).
- Delivery: staff-manual plus HMAC-signed links (`POST …/deliverables/:id/links`
  → `/api/dl/:token`, ≤ 14 days, revocable, downloads audited). Advisory
  strategies render qualitatively — never as $0 rows.

## 8. Engagement loop

- `engagements` per plan; OpenSign (letter) + Stripe (payment) adapters are
  env-driven. Unconfigured → typed `not_configured` → use the audited admin
  manual override (Record letter-sent / letter-signed / invoice-sent /
  payment-received).
- Webhooks: `/api/webhooks/opensign` (HMAC hex) and `/api/webhooks/stripe`
  (t=/v1=, 5-min tolerance), idempotent via the `webhook_events` ledger.
  Signed AND paid auto-advances presented → engaged and unlocks strategy names
  in client deliverables.
- Stripe invoices use `send_invoice` collection: Stripe **emails the hosted
  invoice on finalization only if the account's "Email finalized invoices to
  customers" setting is enabled** (Stripe's default — verify it in Dashboard →
  Settings → Billing before go-live). Send-invoice requires the client record
  to carry a contact email; a deliberate re-send voids the previously issued
  invoice so the client can't pay both.

## 9. Claude seam & jobs

- All background Claude calls go through `callClaude(job, …)`: per-job model pin
  - hard token budget (`jobs-config.ts`), retry/backoff, and a `claude.call`
    audit row with request/response hashes (payloads never persisted).
- `ANTHROPIC_KILL_SWITCH=1` blocks everything instantly; `SHIELD_URL` routes all
  traffic through an egress proxy. ZDR is an org-level Anthropic setting.
- **No API key is a supported mode**: chat and Claude jobs idle with logged
  skips; the engine, library, plans, deliverables, gates, and local jobs
  (golden-regression, archive-scan) are fully functional.
- Plan memos: opt-in setting `plan_memos_enabled`; drafts are always
  DRAFT-labeled; 503 without a key.

## 10. Operations

- Queues: Bull Board at `/admin/queues` (crons: skills nightly, usage hourly,
  tables-draft Oct 1, strategy-watch + archive-scan weekly).
- Review queue: `/admin/review-queue` — assign a named owner and cadence.
- Backups: `scripts/backup.sh` (compose or `BACKUP_MODE=local`), restore via
  `scripts/restore.ts`; run the restore drill per `docs/deployment-checklist.md`
  §4. `DELIVERABLES_DIR` and `attachments/` need file-level backup separately.
- Migrations: 0000–0012, additive-only. `pnpm db:migrate` then `pnpm db:seed`
  (idempotent — safe to re-run on every deploy).

## 11. Verified reference walk (TP-16)

Executed on a fresh database at rollout: migrate 0000–0012 → double-seed (second
run inserts 0) → create client → plan → typed intake → scenario with an
elevated-risk strategy → compute (matches the embedded golden exactly) →
in-review → gate blocked (checklist, then elevated-risk link) → research launch →
archive (auto-links) → gate passes → presented → compute 409 frozen → advisor PDF
(PDFKit) → signed link → public download → client-pdf 402 unlicensed →
entitled → signed OpenSign + Stripe webhook fixtures → auto-advance to engaged →
client-pdf renders with names revealed → pipeline jobs skip cleanly with no key.
