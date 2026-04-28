# QUESTIONS.md

Ambiguities encountered during the autonomous build, with the default applied and where to flip
the switch later. Per the kickoff protocol: pick a reasonable default consistent with §3 of
`BUILD_PLAN.md`, log here, never block.

---

## Scaffolding scope (kickoff)
**Question:** The kickoff prompt asked for a full v1.0.0 build in one autonomous session.
**Default applied:** Wide-scaffolding pass (kickoff option 2). All 29 phases are sketched as a
navigable skeleton with file stubs, schema, route handlers, Docker config, and docs. No phase is
claimed "done"; tests are present where the logic is concrete (crypto, cost calc, routing) and
stubbed elsewhere. No `v1.0.0` tag is created.
**Rationale:** A full 8-week build cannot be honestly completed and verified in one session.
The user authorized the scaffolding option explicitly.
**Reversible:** Yes — each phase has explicit TODOs marking what remains to be implemented.

## Missing reference assets
**Question:** `mockup.html` is referenced by Phases 14, 15, 18, 19, 20 as the visual target but
is not present in the repo. Same for `KICKOFF_PROMPT.md`.
**Default applied:** Chat view is built to the editorial-aesthetic description in the kickoff
prompt (warm paper #f7f3ec, deep ink #1a1714, oxblood #7a2a1a, moss #2f4a30, gold #b48a3a,
Fraunces / Source Serif 4 / JetBrains Mono). Authorities/Compliance/Skills/Cost panels are
first-class as described.
**Rationale:** The aesthetic description is enough to scaffold the panels; a real mockup would
sharpen spacing, hierarchy, and microcopy.
**Reversible:** Yes — drop `mockup.html` into the repo root and re-evaluate `apps/web/src/styles/theme.ts` and the chat panels under `apps/web/src/components/panels/`.

## Skills repo content
**Question:** The Vibe-Claude-Tax-Research-Skills upstream repo is referenced for ingestion
(Phase 7) and routing (Phase 11), but the actual skill content cannot be assumed in this build
session.
**Default applied:** Ingestion + parser + routing logic written against the documented SKILL.md
shape (YAML frontmatter with `name`, `description`, optional `status`). Fixture skills under
`packages/db/seeds/fixture-skills/` exercise the parser. The 8-skill cap and always-attached
`cpa-pack-index` + `compliance-ssts-circular230` are honored.
**Rationale:** Parser and routing must be deterministic and testable before the actual repo is
synced.
**Reversible:** Drop the real repo, re-run `pnpm tsx scripts/skills-ingest.ts`.

## Manifest URL availability
**Question:** `https://vibemb.com/manifests/anthropic-models.json` is the documented refresh
target for the model registry (Phase 6). Network state in the build env is unknown.
**Default applied:** Refresh endpoint fetches the URL with 5-second timeout and returns a
structured diff (`{ added, updated, removed, unchanged }`). On fetch failure: returns an error
the UI surfaces, no DB mutation. Bundled `packages/db/seeds/models.json` always seeds the table
on first run.
**Rationale:** Operability is more important than blocking on network at install time.
**Reversible:** Set `MODELS_MANIFEST_URL` to a different host.

## Cost-streaming UX
**Question:** Pure JS estimate vs periodic Haiku tokenizer call (kickoff §10 item 6).
**Default applied:** JS estimate (`chars / 4`) during streaming, snaps to actual on
`message_delta`.
**Rationale:** Cheap, no extra API spend per turn.
**Reversible:** Swap `apps/web/src/components/CostLedger.tsx` provisional logic.

## Chat history retention
**Question:** Forever vs 7 years (kickoff §10 item 2).
**Default applied:** Forever; admin-configurable via `settings.chat_retention_days` (null =
forever).
**Reversible:** Change setting; nightly job in `apps/api/src/jobs/retention.ts` (stub).

## Per-chat model override
**Question:** Admin-only or per-user (kickoff §10 item 5).
**Default applied:** Per-user, gated by `users.can_override_model` flag (default true).
**Reversible:** Flip the flag, or remove the model picker from `apps/web/src/components/ChatHeader.tsx`.

## Single API key vs per-user
**Question:** Per-user keys for individual billing (kickoff §10 item 1).
**Default applied:** Single appliance key in v1; the schema does **not** include a per-user
override column to keep migration cleanly reversible.
**Reversible:** v1.5 phase will add `users.anthropic_key_ciphertext` and a fallback chain.

## Stub-state warnings
**Question:** Banner on assistant messages citing `stub`-status skills (kickoff §10 item 4).
**Default applied:** Yes — the Authorities panel renders a warning chip when any cited authority
comes from a skill whose `skill_versions.status_field == 'stub'`.
**Reversible:** Suppress in `apps/web/src/components/panels/AuthoritiesPanel.tsx`.

## Dispatcher visibility
**Question:** Show or hide the dispatcher's chosen skills in UI (kickoff §10 item 3).
**Default applied:** Show. Phase 20's Skills panel renders `cpa-pack-index` (oxblood),
`compliance-ssts-circular230` (moss), and routed skills.
**Reversible:** Hide via `settings.show_skills_panel = false`.
