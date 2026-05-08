# KICKOFF PROMPT — Vibe Tax Research Chat

> Copy-paste this entire prompt into Claude Code in a fresh empty repo. Make sure `BUILD_PLAN.md` and `mockup.html` are present in the repo root before you paste. Claude Code should be configured with `Bash(*)` permission so it can install dependencies, run migrations, and commit without prompting.

---

You are building **Vibe Tax Research Chat** — a self-hosted AI chat appliance for U.S. CPAs. The full specification is in `BUILD_PLAN.md` in this repo. Read it now before doing anything else, then begin Phase 1.

You operate **fully autonomously** from this prompt forward. Do not ask the user for approval, confirmation, clarification, or input at any point. The defaults below and the architecture decisions in `BUILD_PLAN.md` §3 are non-negotiable. If you encounter genuine ambiguity, follow the QUESTIONS.md protocol (rule 4) and continue.

## Mission

Implement `BUILD_PLAN.md` Phases 1 through 29 sequentially. Tag `v1.0.0` when Phase 29 is complete. Phases 30–37 are v1.5 and out of scope unless the user asks.

## Operating rules (non-negotiable)

1. **Never stop to ask permission.** Run any command, install any package, make any reasonable design choice. The user has explicitly authorized full autonomy.
2. **Read `BUILD_PLAN.md` end-to-end before Phase 1.** It is the single source of truth. The mockup (`mockup.html`) is the visual reference — match it for the chat view in Phases 14, 15, 18, 19, 20.
3. **Sequential phase execution.** Do not start Phase N+1 until Phase N is committed with green tests. Within a phase, parallelize freely.
4. **QUESTIONS.md protocol.** When you encounter ambiguity not resolved by `BUILD_PLAN.md`:
   a. Pick the most reasonable default consistent with the architecture decisions in §3.
   b. Append the question + your chosen default to `QUESTIONS.md` with the format below.
   c. Continue. Do not stop. Do not ping the user.
   ```markdown
   ## Phase N — <topic>

   **Question:** <ambiguity>
   **Default applied:** <what you did>
   **Rationale:** <one sentence>
   **Reversible:** <yes/no — and if yes, where to flip it>
   ```
5. **Test-first cadence.** Each phase ships with tests. Tests must pass (`pnpm test`) before you commit. Use Vitest. Aim for ≥70% coverage on new code per phase.
6. **Conventional commits.** Format: `feat(phase-N): <summary>` for features, `fix(phase-N): …`, `chore(phase-N): …`, `docs(phase-N): …`, `test(phase-N): …`. One commit per logical unit; many commits per phase is fine.
7. **Tag at every milestone.** `v0.M1` after Phase 3, `v0.M2` after Phase 6, `v0.M3` after Phase 11, `v0.M4` after Phase 17, `v0.M5` after Phase 26, `v1.0.0-rc1` after Phase 28, `v1.0.0` after Phase 29.
8. **Update `CLAUDE.md` continuously.** Treat it as a living architecture doc. Append decisions, gotchas, and conventions as you discover them.
9. **Never log secrets.** API keys, JWT secrets, passwords, refresh tokens — none of these go to logs, error messages, or commit messages.

## Stack constraints (non-negotiable, per BUILD_PLAN.md §3.1)

- pnpm workspaces: `apps/web`, `apps/api`, `packages/db`, `packages/shared`
- Frontend: React 18 + TypeScript + Vite + Tailwind + TanStack Query + Zustand
- Backend: Node 24 + Express + TypeScript + Pino
- DB: Drizzle ORM + PostgreSQL 16
- Cache/queue: Redis 7 + BullMQ
- AI: `@anthropic-ai/sdk` with `betas: ["code-execution-2025-08-25", "skills-2025-10-02"]`
- Editor: Monaco for skill authoring and diff views
- Streaming: Server-Sent Events (SSE)
- Container: Docker Compose, single-tenant appliance

Do not introduce other major dependencies (no Next.js, no Prisma, no Yjs, no tRPC) without logging the substitution to `QUESTIONS.md` first with rationale.

## Security constraints (non-negotiable, per BUILD_PLAN.md §3.5, §3.9)

- Anthropic API keys: AES-256-GCM at rest, HKDF-derived from `MASTER_KEY` env var. Decrypt only at the moment of an API call. Never persist plaintext. Return only fingerprints from `GET` endpoints.
- Passwords: bcrypt with cost factor 12.
- JWT: separate access (15 min) and refresh (30 day) secrets. Refresh-token rotation. Hashed storage of refresh tokens.
- All admin actions write to `audit_log`.
- Brute-force rate limiting on `/login` (5 attempts / 15 min / IP via Redis sliding window).
- Helmet, CORS, body size limits set sensibly.

## Reference data (per BUILD_PLAN.md §6)

The April 2026 Anthropic pricing seed:

- `claude-opus-4-7`: $5 / $25 per MTok, tokenizer factor 1.18
- `claude-opus-4-6`: $5 / $25 per MTok
- `claude-sonnet-4-6`: $3 / $15 per MTok (default model)
- `claude-haiku-4-5`: $1 / $5 per MTok
- Cache writes 1.25× input, cache reads ~0.10× input (90% off)
- Web fetch + web search: $0.01 each at default

## Skills repo

`https://github.com/KisaesDevLab/Vibe-Claude-Tax-Research-Skills` — the source pack. 33+ skills, BSL 1.1, authored by the same person as this appliance, so no licensing friction. Default pin: `v1.0.0-beta`. The pack's own `cpa-pack-index` is the always-attached dispatcher; `compliance-ssts-circular230` is the always-attached compliance checker.

## Web-resource allowlist (Phase 16)

Locked-domain list for `web_fetch`:

```
uscode.house.gov         (USLM, IRC sections, Popular Name Tool, Classification Tables)
ecfr.gov                 (Treasury Regulations)
federalregister.gov      (TDs, proposed regs, IRS notices)
dawson.ustaxcourt.gov    (Tax Court opinions)
irs.gov                  (IRS Bulletin, Rev. Procs, Rev. Ruls, Notices)
govinfo.gov              (Public Law text)
ftb.ca.gov               (California FTB)
tax.ny.gov               (NY DTF)
comptroller.texas.gov    (Texas Comptroller)
floridarevenue.com       (Florida DOR)
tax.illinois.gov         (Illinois DOR)
revenue.pa.gov           (Pennsylvania DOR)
tax.ohio.gov             (Ohio Department of Taxation)
nj.gov/treasury/taxation (NJ Division of Taxation)
dor.georgia.gov          (Georgia DOR)
ncdor.gov                (NC DOR)
```

## Mockup reference

`mockup.html` is the visual target for the chat view. Match the editorial / research-publication aesthetic: warm paper background (`#f7f3ec`), deep ink text (`#1a1714`), oxblood accent (`#7a2a1a`) for citations, moss (`#2f4a30`) for compliance, gold (`#b48a3a`) for footnotes. Fonts: Fraunces (display, variable), Source Serif 4 (body), JetBrains Mono (cost numbers and citation chips). The five panels under each assistant message — Authorities, Compliance, Skills, Cost — are first-class UI, not afterthoughts.

## Phase execution loop

For each phase 1..29:

1. Read `BUILD_PLAN.md` §5 for that phase. Note dependencies, scope, checklist, and "Done when" acceptance criteria.
2. Implement every checklist item. Write tests as you go.
3. Run `pnpm lint && pnpm test`. Fix any failures.
4. Verify the "Done when" criterion holds. If you cannot satisfy it, log to QUESTIONS.md with what's blocking and the workaround you applied — do not stall.
5. Update `CLAUDE.md` with any new architectural notes.
6. Stage and commit with a conventional message: `feat(phase-N): <summary>`.
7. If the phase ends a milestone, run `git tag v0.MX` (or the appropriate v1.0.0 tag).
8. Print a one-line phase summary to stdout: `[Phase N] done · <X> commits · tag <if any>`.
9. Move to the next phase immediately.

## Done criteria for the whole run

You are done when **all** of these are true:

- [ ] All 29 v1 phases committed
- [ ] Tag `v1.0.0` exists
- [ ] `pnpm test` green
- [ ] `docker compose -f docker-compose.prod.yml up -d` produces a working appliance
- [ ] The reference research turn from `BUILD_PLAN.md` §12 (the §199A QBI question) executes end-to-end against a real Anthropic key, producing verified authorities, compliance checklist, skills attribution, and an accurate cost ledger
- [ ] `README.md` is complete enough that a CPA could install unaided

When all the above pass, print:

```
v1.0.0 ready.
Repo: <path>
Tag: v1.0.0
Tests: <pass count>/<total>
Commits since kickoff: <n>
QUESTIONS.md entries logged: <n>
Next steps for the user: review QUESTIONS.md, push to KisaesDevLab/Vibe-Tax-Research-Chat, run docker compose up.
```

## Begin now

Read `BUILD_PLAN.md` and `mockup.html` in full. Then start Phase 1. Do not respond to me — just work. The next thing I should see from you is the `v1.0.0 ready.` message.
