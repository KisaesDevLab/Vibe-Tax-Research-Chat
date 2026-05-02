# Vibe-Tax-Research-Chat — Appliance Compatibility Addendum

Companion to `docs/PLAN.md` (the Vibe-Appliance plan) and to `vibe-appliance-emergency-access-addendum.md`. This document specifies the changes needed in `KisaesDevLab/Vibe-Tax-Research-Chat` so that a single set of GHCR images runs cleanly in two deployment modes:

- **Standalone:** customer runs the app's existing install path; bundled Postgres (with required extensions); customer brings their own LLM endpoint or runs Ollama locally; current behavior, must not regress.
- **Appliance:** the Vibe-Appliance composes Vibe-Tax-Research-Chat alongside other Vibe apps; **shared Postgres must be ParadeDB or pgvector-equipped**; LLM endpoint provided by Vibe-GLM-OCR; behind Caddy at `tax.<domain>` with three documented access methods.

Tax-Research-Chat is the most architecturally novel Vibe app for the appliance because it depends on three pieces of infrastructure that other Vibe apps don't need: **a hybrid-retrieval-capable Postgres** (pgvector + BM25), **an external LLM service** (without which the app is non-functional), and **a tax authority corpus** that needs versioning, updates, and per-firm overlays.

This addendum spends most of its weight on coordinating these three dependencies. The common-requirements work is comparatively boring.

---

## 0. Two upstream changes this addendum depends on

Before any work in sections 1–9 can be released, two parent-plan changes must land:

1. **Confirm ParadeDB as the appliance's shared Postgres image.** PLAN.md §8.2 tentatively recommended this; this addendum assumes it. If you'd rather Tax-Research-Chat ship its own dedicated Postgres container, sections 5.2 and 5.10 of this document need rewriting. **Decision needed before PR 1 of this addendum lands.**

2. **Vibe-GLM-OCR's role expansion.** Today, GLM-OCR runs Ollama with the GLM-OCR model loaded for document OCR. To support Tax-Research-Chat, GLM-OCR must also load Qwen3-8B (chat synthesis), BGE-M3 (embeddings), and bge-reranker-v2-m3 (reranking). This is a configuration change in GLM-OCR's manifest and Ollama startup, not new code. Document in the GLM-OCR addendum (which we haven't written yet — it's the smallest of the family). For this addendum, assume GLM-OCR provides three additional Ollama-served endpoints.

These are listed as `Status: needed` in §6 (PR plan). Tax-Research-Chat work can proceed in parallel with GLM-OCR's role expansion; integration testing requires both.

---

## 1. Design principles

Same three rules as the other addenda. If a future change violates one, push back.

1. **Standalone behavior must not change for existing customers.** Identical setup, identical defaults after this work ships.
2. **One image, two modes.** Same `ghcr.io/kisaesdevlab/vibe-tax-research-*` images run both standalone and appliance.
3. **Configuration over forks.** Every behavioral difference is an env var or compose overlay.

Plus two Tax-Research-Chat-specific rules:

4. **The LLM is hot-swappable.** Customers must be able to point Tax-Research-Chat at any OpenAI-compatible endpoint — Ollama (local), llama.cpp server, vLLM, OpenAI's API, Anthropic with translation shim, etc. The appliance default is Vibe-GLM-OCR's Ollama; nothing in the app code should hardcode that.

5. **Citations are non-negotiable.** Tax research without citations is malpractice for a CPA. Every claim in every response must be tied to specific source documents. The architecture (RAG + GBNF-grammar-enforced output + Eyecite verification) must remain even when the LLM model is swapped.

---

## 2. Audit summary

Tax-Research-Chat was the app I couldn't read during the appliance plan reconnaissance (GitHub rate limit). This audit table is therefore more "needs verification" than the others. Items marked **🔍** require Claude Code to inspect the repo and report back before fixes are written.

| Item                           | Today                                                      | Target                                                                                  | Notes                                       |
| ------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| License                        | 🔍 Verify ELv2 or BSL 1.1                                  | ELv2 (matches family)                                                                   | Audit; if proprietary, blocker like Connect |
| Stack                          | React + TS + Node 20 + Express + PG (with pgvector + BM25) | Same                                                                                    | No stack changes                            |
| Standalone install             | 🔍 Verify                                                  | Unchanged                                                                               | Must keep working                           |
| GHCR images                    | 🔍 Verify multi-arch                                       | amd64 + arm64; tags `latest` / `vN.M.K` / `sha-<short>`                                 | §3 (common)                                 |
| DB config                      | 🔍 Verify                                                  | `DATABASE_URL` only                                                                     | §3 (common)                                 |
| Postgres requirement           | pgvector + BM25                                            | Same; appliance provides via ParadeDB                                                   | §5.2                                        |
| `ALLOWED_ORIGIN`               | 🔍 Verify                                                  | Comma-separated list with regex                                                         | §3 (common)                                 |
| Migrations                     | 🔍 Verify auto-on-startup                                  | Gated by `MIGRATIONS_AUTO` (default `true`)                                             | §3 (common)                                 |
| `/health` + `/ping`            | 🔍 Verify                                                  | `/health` checks DB+LLM+embeddings; `/ping` cheap liveness                              | §5.4                                        |
| LLM endpoint                   | 🔍 Verify configurability                                  | `LLM_ENDPOINT` + `LLM_MODEL` env vars; required, not optional                           | §5.1                                        |
| Embeddings endpoint            | 🔍 Verify                                                  | `EMBEDDINGS_ENDPOINT` + `EMBEDDINGS_MODEL`; required                                    | §5.1                                        |
| Reranker endpoint              | 🔍 Verify                                                  | `RERANKER_ENDPOINT` + `RERANKER_MODEL`; optional                                        | §5.1                                        |
| Authority corpus               | Bundled? Volume?                                           | Volume-mounted; versioned; updateable                                                   | §5.3                                        |
| Embedding index                | 🔍 Verify rebuild flow                                     | Rebuildable on corpus update; admin-triggered or auto                                   | §5.4                                        |
| Citation verification          | Eyecite + IRS tokenizers                                   | Same; verify in CI tests                                                                | §5.5                                        |
| PII redaction                  | Microsoft Presidio                                         | Same; verify enabled by default in appliance                                            | §5.6                                        |
| State coverage                 | 8 states v1.0                                              | Configurable per install via `ENABLED_STATES`                                           | §5.7                                        |
| Streaming responses            | 🔍 Verify SSE or WebSocket                                 | Server-Sent Events through Caddy and HAProxy                                            | §5.8                                        |
| Workers                        | If any (corpus indexing)                                   | Env-driven, heartbeats to Redis                                                         | §3 (common)                                 |
| Logs                           | 🔍 Verify                                                  | Stdout structured JSON; PII redaction in logs explicit                                  | §3 (common)                                 |
| Compose files                  | 🔍 Verify                                                  | Add `docker-compose.appliance.yml`                                                      | §5.10                                       |
| Manifest                       | None                                                       | `.appliance/manifest.json` with `emergencyPort: 5191`, hard `depends: ["vibe-glm-ocr"]` | §5.11                                       |
| Volumes                        | Bundled                                                    | Bundled in standalone; named-volume references in appliance                             | §5.12                                       |
| Emergency-access compatibility | 🔍 Verify                                                  | All audits per other addenda                                                            | §5.13                                       |

The 🔍 items are the actionable first task: Claude Code reads the repo, fills in the "Today" column with reality, and only then starts the fix work.

---

## 3. Common-requirements pass

Items 1–10 of PLAN.md §8.1 apply to Tax-Research-Chat without per-app variation. Same audits and fixes as MyBooks (§3.1–3.7, 3.9, 3.12). Two things specific to Tax-Research-Chat:

- **`/health` checks LLM and embeddings reachability.** Without those, the app can't function. Health degrades to 503 if the LLM endpoint is unreachable for >2 consecutive probe cycles. Workers and DB still important but secondary — the LLM dependency is the dominant concern.
- **Logging policy is stricter.** Tax research conversations may contain client SSNs, EINs, or other PII even with Presidio scrubbing on the way in. Server logs must redact these patterns before writing, in addition to standard "no secrets" rule. Log format: structured JSONL with `redacted: true` flag where redaction was applied.

---

## 4. Three access methods × audience

Tax-Research-Chat is **staff-internal**. Single audience: tax preparers, reviewers, partners doing research. No client portal, no kiosk, no external access. Like Trial Balance.

|                                    | Primary (`https://tax.firm.com`) | Tailscale (`https://tax.<tailnet>.ts.net`) | Emergency (`http://<ip>:5191`) |
| ---------------------------------- | -------------------------------- | ------------------------------------------ | ------------------------------ |
| **Staff** (researchers, preparers) | ✅ Full                          | ✅ Full                                    | ✅ Full                        |

All three methods fully work. The only caveat is performance — LLM responses stream over Server-Sent Events (§5.8), and any proxy that doesn't pass through SSE correctly will make the chat feel broken. Caddy and HAProxy both handle SSE correctly with the right config; verify in tests.

**Emergency mode is a true full fallback for Tax-Research-Chat.** Same as TB. This is worth advertising to customers: _"Tax research doesn't depend on external connectivity to the firm key or to client communication. If primary access fails, researchers keep working over emergency access — full functionality."_

---

## 5. Tax-Research-Chat-specific changes

### 5.1 LLM, embeddings, and reranker endpoints

**Goal.** All three ML inference dependencies are configurable, runnable against any OpenAI-compatible endpoint, and gracefully report unhealthy state when unreachable.

**Action.**

- Three env-var pairs:
  - `LLM_ENDPOINT` + `LLM_MODEL` — synthesis model. Default in appliance: `http://vibe-glm-ocr:11434/v1` and `qwen3-8b-q4_k_m`. **Required.** App refuses to start if unset.
  - `EMBEDDINGS_ENDPOINT` + `EMBEDDINGS_MODEL` — embedding model for queries and corpus indexing. Default in appliance: `http://vibe-glm-ocr:11434/v1` and `bge-m3`. **Required.**
  - `RERANKER_ENDPOINT` + `RERANKER_MODEL` — reranker for top-k results. Default in appliance: `http://vibe-glm-ocr:11434/v1` and `bge-reranker-v2-m3`. **Optional** — if unset, retrieval skips the rerank step (slightly worse quality; usable).
- Optional API keys: `LLM_API_KEY`, `EMBEDDINGS_API_KEY`, `RERANKER_API_KEY` for endpoints that require auth (OpenAI, Anthropic). Empty for Ollama (no auth on local endpoint).
- Model-loading verification at startup: app issues a tiny test request to each configured endpoint and verifies the model is loaded. If the endpoint returns "model not found," app logs a clear error pointing at how to load the model in Ollama (`ollama pull qwen3:8b` etc.) and refuses to start.
- Periodic health probe: every 60s, app pings each endpoint with a minimal request and updates `/health` status accordingly.

**Tests.**

- Endpoint configured but unreachable at startup: app exits with clear message naming the unreachable endpoint and the model.
- Endpoint reachable but model not loaded: app exits with "Run `ollama pull <model>` on the LLM host" guidance.
- All three endpoints healthy at startup: app starts and serves traffic.
- LLM endpoint goes down at runtime: `/health` returns 503; in-flight requests fail with user-friendly error; resolves automatically when endpoint recovers.
- Reranker endpoint unset: app starts and serves traffic, retrieval skips rerank, quality slightly degraded but usable.

**Standalone impact.** Standalone customers must configure these explicitly — no defaults, since standalone has no Vibe-GLM-OCR. Document the required setup clearly in the standalone install guide.

### 5.2 ParadeDB / pgvector requirement

**Goal.** Postgres has both pgvector (HNSW vector index) and BM25 (ParadeDB's bm25 extension or similar) for hybrid retrieval.

**Action.**

- App startup checks for the required extensions via `SELECT * FROM pg_extension WHERE extname IN ('vector', 'pg_search')` (or whatever the BM25 extension is named — verify against ParadeDB current version).
- If extensions missing, app refuses to start with clear instructions: "Tax-Research-Chat requires Postgres with pgvector and pg_search extensions. The Vibe-Appliance ships these via ParadeDB; for standalone, install ParadeDB or install the extensions individually."
- Migrations create extensions on first run if the DB user has permission: `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_search;`. Appliance grants the extension-create privilege to the per-app role at DB bootstrap.
- HNSW index created on the corpus embedding table at appropriate dimensions (1024 for BGE-M3).
- BM25 index on the corpus full-text content.

**Decision (parent plan).** ParadeDB as the appliance's shared Postgres image is the right call. The cost is ~30MB image-size increase over vanilla `postgres:16` and minor RAM overhead per connection. Apps that don't use vectors don't notice; apps that do (Tax-Research-Chat, possibly future apps) get them for free.

**If the parent plan changes its mind** and decides Tax-Research-Chat gets its own dedicated Postgres container, this section becomes simpler (the container ships ParadeDB at known dimensions) but the appliance compose grows by one DB and Duplicati backup gets one more thing to track. Default decision stands.

**Tests.**

- ParadeDB shared Postgres: extensions present, migrations succeed, HNSW + BM25 indexes built.
- Vanilla Postgres: app refuses to start with clear extension-missing message.
- Standalone with pgvector + ParadeDB extensions installed manually: works.

**Standalone impact.** Customers who currently run Tax-Research-Chat standalone are presumably already using a pgvector-equipped Postgres. Confirm.

### 5.3 Authority corpus management

**Goal.** The federal + 8-state authority corpus is versioned, updateable, and supports per-firm overlay documents (firm-private research notes added to the corpus).

**Action.**

- Corpus structure on disk:

  ```
  /opt/vibe/data/apps/vibe-tax-research/corpus/
  ├── manifest.json                      # version, sources, last-update, doc count
  ├── federal/
  │   ├── ecfr/                          # eCFR Title 26 sections
  │   ├── irs-bulletins/                 # IRBs, Rev. Proc., Rev. Rul., Notices
  │   ├── courtlistener/                 # tax court opinions
  │   └── federal-register/              # NPRMs and final rules
  ├── states/
  │   ├── ca/
  │   ├── ny/
  │   ├── tx/
  │   ├── ...
  └── firm-overlay/                      # firm-uploaded documents
      ├── note-001.md
      ├── memo-002.md
      └── ...
  ```

- Corpus distribution: not bundled in the app image (would balloon to 5+ GB). Two paths:
  - **Bootstrap fetch** at appliance install: `vibe install --tax-research-corpus federal,states/{ca,ny,tx,fl,il,oh,pa,wa}` downloads from a Kisaes-hosted CDN. Initial fetch is one-time, ~2 GB compressed.
  - **Manual restore** for air-gapped customers: download a tarball from `corpus.kisaes.com`, scp it to the host, untar to the corpus volume.
- Corpus updates:
  - Federal sources update quarterly minimum (IRBs, regs). Kurt publishes new corpus tarballs to `corpus.kisaes.com` with semantic versioning (e.g., `corpus-2025q3.tar.gz`).
  - Console admin shows "Corpus version: 2025q2 (Released 2025-06-30) — Update available: 2025q3" with a one-click update button.
  - Update flow: download new tarball, verify signature (Ed25519 against Kisaes public key baked into the app), atomic-replace corpus directory, trigger reindex (§5.4).
  - State corpus updates per state, on the same cadence.
- Firm overlay: admin can upload markdown/PDF documents via the admin UI. These go into `firm-overlay/`, are PII-scrubbed via Presidio (§5.6), embedded, indexed alongside authoritative content. Marked clearly in citations as "Firm research" not "Authority."

**Tests.**

- Fresh appliance install: corpus fetch completes; manifest.json has expected version; document count matches expected for selected states.
- Corpus update flow: trigger update, new tarball downloads, signature verifies, atomic replace, reindex completes, search uses new content.
- Firm overlay upload: admin uploads a memo, document is scrubbed for PII, embedded, retrievable via search, cited as "Firm research."
- Signature verification fails: refuse to apply update, log clear error.

**Standalone impact.** Standalone customers manually fetch corpus tarballs; same tarballs, same signature scheme, same update flow.

### 5.4 Embedding index and reindex flow

**Goal.** Corpus updates trigger reindexing without taking the app offline. Reindex is observable and resumable.

**Action.**

- Reindex runs as a worker job via BullMQ. Triggered by:
  - Corpus update completion (automatic).
  - Admin "Rebuild index" button (manual; useful for embedding-model upgrades).
  - Initial bootstrap when no embeddings exist for the corpus version.
- Reindex strategy: rolling, not stop-the-world. Build new HNSW index in a `corpus_embeddings_new` table, then atomic-rename to `corpus_embeddings` when complete. Old index served until swap. Search availability uninterrupted.
- Progress tracking: worker writes progress (documents indexed, embeddings generated, errors) to Redis every 5 seconds. Admin UI shows a progress bar.
- Estimated time: ~30 minutes for federal corpus on a single worker with BGE-M3 served by Ollama on a NucBox M6. Larger states proportional.
- Resumable: if a reindex job is killed mid-run, restarting it picks up where it left off (per-document checkpointing in Redis).
- Embedding model upgrades require a full reindex with the new model. Surface this clearly in the corpus-update UI: "Upgrading to BGE-M3-v2 requires reindexing (estimated 45 minutes). Search remains available during reindex but uses the old index."

**Tests.**

- Initial bootstrap: corpus fetched, reindex runs, search returns relevant results.
- Corpus update with same embedding model: reindex completes; old results consistent with new ones; no search downtime observed.
- Embedding model upgrade: reindex completes; search quality measurably improves (compare against a regression query set).
- Mid-reindex interruption: restart the worker; reindex resumes; final state is correct.

**Standalone impact.** Same flow standalone.

### 5.5 Citation verification

**Goal.** Every claim in every response is tied to a specific source document with a verifiable citation. Citations are checked at response time, not just at training/indexing time.

**Action.**

- LLM output is GBNF-grammar-constrained to emit per-claim citations in a structured format (e.g., `<claim>...<cite source="ecfr:26-CFR-1.61-1" /></claim>`).
- After LLM emits response, app runs Eyecite + custom IRS tokenizers to extract citations from the response.
- Each extracted citation is verified against the corpus: the source document must exist, the cited section must contain content semantically related to the claim (cosine similarity check).
- If a citation can't be verified, the claim is flagged in the response with an explicit warning: "[citation could not be verified]". This is brutal for UX but the right behavior for a tax research tool — silent unverifiable citations are worse than visible ones.
- Citation format in UI: clickable, expands to show the cited source text inline.
- Audit log: every chat response stored with verification results for compliance trail.

**Tests.**

- Synthetic question with a known correct answer: response cites correct authority, verification passes.
- Synthetic question that prompts the model to hallucinate: response cites a fake source; verification flags it.
- Citation format regression: a known set of 50 (question, expected citation) pairs runs in CI.

**Standalone impact.** None — same logic across modes.

### 5.6 PII redaction with Presidio

**Goal.** SSNs, EINs, names, addresses in user queries and uploaded firm documents are scrubbed before going to the LLM (which may be a third-party API in some configurations).

**Action.**

- Microsoft Presidio runs as a sidecar or in-process. In-process is simpler if dependencies allow; sidecar is more isolated.
- Two redaction passes:
  - **Query redaction**: user types a question; Presidio scrubs PII before the question is embedded or sent to the LLM. The scrubbed version is what's sent; the original is retained in the user's session for display.
  - **Document redaction**: when admin uploads firm overlay documents, Presidio scrubs PII before indexing. Original documents kept on disk in encrypted storage (firm-only access); indexed content is the redacted version.
- Confidence threshold for redaction: configurable via `PRESIDIO_CONFIDENCE_THRESHOLD` env var, default `0.7`. Lower = more aggressive (more false positives), higher = less aggressive (more false negatives).
- Audit log: every redaction recorded with what was redacted (token type, position in text), but NOT the redacted content itself. This proves redaction happened without storing the PII it caught.

**Tests.**

- Query "What's the deduction for an EIN 12-3456789 with revenue under $X" → SSN/EIN scrubbed before LLM sees it.
- Firm overlay containing client names → names scrubbed in indexed version, intact in original on disk.
- Confidence threshold tuning: known false-positive cases (corporate boilerplate that looks SSN-like) tracked in regression suite.

**Standalone impact.** None — Presidio runs identically in both modes.

### 5.7 State coverage configuration

**Goal.** Customers enable only the states they practice in. No point indexing California tax authority if the firm only does Florida and Texas work.

**Action.**

- New env var `ENABLED_STATES` — comma-separated state codes (`ca,ny,tx,fl,il,oh,pa,wa`). Default in appliance: bootstrap prompts for this. Default in standalone: empty (federal only) until customer configures.
- Corpus fetch only downloads enabled states' corpora.
- Search filters: queries restricted to enabled states' corpora plus federal authority. Out-of-scope state queries returned with "Your firm hasn't enabled <state> coverage. Contact your firm admin to enable" message.
- Admin UI for adding/removing states. Adding triggers a corpus fetch + reindex; removing prunes the state's documents from the index.

**Tests.**

- Bootstrap with `ENABLED_STATES=ca,ny`: only federal + CA + NY corpora downloaded. Index contains only those.
- Query about Texas tax: returns "Texas not enabled" message.
- Add Texas via admin UI: corpus fetched, reindex runs, queries about Texas now work.

**Standalone impact.** Standalone customers configure this same env var. Same flow.

### 5.8 Streaming response support

**Goal.** LLM responses stream token-by-token to the browser, providing perceived responsiveness for long answers. Works through both Caddy and HAProxy.

**Action.**

- Server uses Server-Sent Events (SSE) on `/api/v1/chat/stream`. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- Caddy passes SSE through reverse_proxy with no special config — it's just a long-lived HTTP response.
- HAProxy in `mode http` with sufficient `timeout server` (default 30s is too short for long LLM responses; bump to 600s for the SSE backend specifically). Add a per-frontend timeout override in the emergency-proxy config.
- Client-side: standard `EventSource` API consumes the stream. Auto-reconnect on transient disconnects.
- Cancellation: client closes the EventSource on page navigation or user-clicked-stop. Server detects disconnect and cancels the in-flight LLM request to free resources.

**Tests.**

- Stream a 1000-token response over Caddy. Tokens appear progressively in browser; total time matches LLM generation time (no buffering).
- Same over HAProxy emergency port. Tokens appear progressively.
- User clicks "stop" mid-stream: server cancels LLM request within 1 second; LLM resources freed.
- Network blip mid-stream: EventSource auto-reconnects; partial response preserved client-side.

**Standalone impact.** Same SSE works standalone behind whatever proxy the customer uses. Document the `X-Accel-Buffering: no` header for nginx-fronted standalone deploys.

### 5.9 Sessions and conversation history

**Goal.** Conversations persist across browser sessions and app restarts. Researchers can resume work tomorrow on yesterday's question.

**Action.**

- Conversations stored in DB tables `conversations` and `messages`. Per-user, per-firm.
- Soft-delete with retention policy (configurable via `CONVERSATION_RETENTION_DAYS`, default 365). Admin can purge older conversations.
- Search across own conversations: simple text search, separate from corpus retrieval.
- Export conversation as PDF for inclusion in workpapers.

This is mostly app-feature work; only mentioned here because the manifest needs to expose `CONVERSATION_RETENTION_DAYS` as a configurable env var.

### 5.10 `docker-compose.appliance.yml`

```yaml
# docker-compose.appliance.yml
# Appliance overlay for Vibe-Tax-Research-Chat. Used by Vibe-Appliance.
# Standalone deployments should use docker-compose.yml instead.

services:
  vibe-tax-research-server:
    image: ghcr.io/kisaesdevlab/vibe-tax-research-server:${VIBE_TAX_TAG:-latest}
    networks: [vibe_net]
    environment:
      DATABASE_URL: ${VIBE_TAX_DATABASE_URL}
      REDIS_URL: ${VIBE_TAX_REDIS_URL}
      ALLOWED_ORIGIN: ${VIBE_TAX_ALLOWED_ORIGIN}
      JWT_SECRET: ${VIBE_TAX_JWT_SECRET}
      ENCRYPTION_KEY: ${VIBE_TAX_ENCRYPTION_KEY}
      LLM_ENDPOINT: ${VIBE_TAX_LLM_ENDPOINT:-http://vibe-glm-ocr:11434/v1}
      LLM_MODEL: ${VIBE_TAX_LLM_MODEL:-qwen3:8b-instruct-q4_K_M}
      LLM_API_KEY: ${VIBE_TAX_LLM_API_KEY:-}
      EMBEDDINGS_ENDPOINT: ${VIBE_TAX_EMBEDDINGS_ENDPOINT:-http://vibe-glm-ocr:11434/v1}
      EMBEDDINGS_MODEL: ${VIBE_TAX_EMBEDDINGS_MODEL:-bge-m3}
      EMBEDDINGS_API_KEY: ${VIBE_TAX_EMBEDDINGS_API_KEY:-}
      RERANKER_ENDPOINT: ${VIBE_TAX_RERANKER_ENDPOINT:-http://vibe-glm-ocr:11434/v1}
      RERANKER_MODEL: ${VIBE_TAX_RERANKER_MODEL:-bge-reranker-v2-m3}
      RERANKER_API_KEY: ${VIBE_TAX_RERANKER_API_KEY:-}
      ENABLED_STATES: ${VIBE_TAX_ENABLED_STATES}
      PRESIDIO_CONFIDENCE_THRESHOLD: ${VIBE_TAX_PRESIDIO_THRESHOLD:-0.7}
      CONVERSATION_RETENTION_DAYS: ${VIBE_TAX_CONVERSATION_RETENTION_DAYS:-365}
      MIGRATIONS_AUTO: 'false'
      LOG_LEVEL: ${VIBE_TAX_LOG_LEVEL:-info}
    volumes:
      - vibe-tax-research-corpus:/app/data/corpus
      - vibe-tax-research-uploads:/app/data/uploads
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/api/v1/ping']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

  vibe-tax-research-worker:
    image: ghcr.io/kisaesdevlab/vibe-tax-research-server:${VIBE_TAX_TAG:-latest}
    command: ['node', 'dist/worker.js']
    networks: [vibe_net]
    environment:
      DATABASE_URL: ${VIBE_TAX_DATABASE_URL}
      REDIS_URL: ${VIBE_TAX_REDIS_URL}
      LLM_ENDPOINT: ${VIBE_TAX_LLM_ENDPOINT:-http://vibe-glm-ocr:11434/v1}
      EMBEDDINGS_ENDPOINT: ${VIBE_TAX_EMBEDDINGS_ENDPOINT:-http://vibe-glm-ocr:11434/v1}
      EMBEDDINGS_MODEL: ${VIBE_TAX_EMBEDDINGS_MODEL:-bge-m3}
      WORKER_CONCURRENCY: '2'
      LOG_LEVEL: ${VIBE_TAX_LOG_LEVEL:-info}
    volumes:
      - vibe-tax-research-corpus:/app/data/corpus
    restart: unless-stopped
    depends_on: [vibe-tax-research-server]

  vibe-tax-research-client:
    image: ghcr.io/kisaesdevlab/vibe-tax-research-client:${VIBE_TAX_TAG:-latest}
    networks: [vibe_net]
    restart: unless-stopped
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://localhost:80/']
      interval: 30s
      timeout: 5s
      retries: 3
    depends_on: [vibe-tax-research-server]

networks:
  vibe_net:
    external: true

volumes:
  vibe-tax-research-corpus:
  vibe-tax-research-uploads:
```

Notes:

- Worker mounts the corpus volume (read-only would be safer; verify whether corpus updates happen via the worker or the server).
- `start_period: 60s` for the server health check — model warm-up on first start can take 30+ seconds against a cold Ollama.
- No published ports.
- Defaults assume Vibe-GLM-OCR is available on the same `vibe_net`. If GLM-OCR is disabled, Tax-Research-Chat refuses to start.

### 5.11 `.appliance/manifest.json`

```json
{
  "schemaVersion": 1,
  "slug": "vibe-tax-research",
  "displayName": "Vibe Tax Research",
  "description": "AI-augmented tax research with citation-first answers over federal and state authority",
  "logo": "tax-research.svg",
  "userFacing": true,
  "image": {
    "server": "ghcr.io/kisaesdevlab/vibe-tax-research-server",
    "client": "ghcr.io/kisaesdevlab/vibe-tax-research-client",
    "defaultTag": "latest"
  },
  "ports": { "server": 3000, "client": 80 },
  "subdomains": [
    {
      "name": "tax",
      "target": "vibe-tax-research-client:80",
      "audience": "default",
      "emergencyPort": 5191
    }
  ],
  "depends": ["postgres", "redis", "vibe-glm-ocr"],
  "postgresExtensions": ["vector", "pg_search"],
  "websocket": false,
  "streaming": "sse",
  "env": {
    "required": [
      { "name": "JWT_SECRET", "generate": "hex32" },
      { "name": "ENCRYPTION_KEY", "generate": "hex32" },
      {
        "name": "DATABASE_URL",
        "from": "shared-postgres-url",
        "database": "vibe_tax_research_db",
        "user": "vibetax"
      },
      { "name": "REDIS_URL", "from": "shared-redis-url", "namespace": "tax-research" },
      { "name": "ALLOWED_ORIGIN", "from": "subdomain-url" },
      { "name": "LLM_ENDPOINT", "default": "http://vibe-glm-ocr:11434/v1" },
      { "name": "LLM_MODEL", "default": "qwen3:8b-instruct-q4_K_M" },
      { "name": "EMBEDDINGS_ENDPOINT", "default": "http://vibe-glm-ocr:11434/v1" },
      { "name": "EMBEDDINGS_MODEL", "default": "bge-m3" },
      { "name": "ENABLED_STATES", "from": "customer-prompt", "default": "" }
    ],
    "optional": [
      { "name": "RERANKER_ENDPOINT", "default": "http://vibe-glm-ocr:11434/v1" },
      { "name": "RERANKER_MODEL", "default": "bge-reranker-v2-m3" },
      { "name": "LLM_API_KEY", "secret": true },
      { "name": "EMBEDDINGS_API_KEY", "secret": true },
      { "name": "RERANKER_API_KEY", "secret": true },
      { "name": "PRESIDIO_CONFIDENCE_THRESHOLD", "default": "0.7" },
      { "name": "CONVERSATION_RETENTION_DAYS", "default": "365" },
      { "name": "WORKER_CONCURRENCY", "default": "2" },
      { "name": "LOG_LEVEL", "default": "info" }
    ]
  },
  "database": { "name": "vibe_tax_research_db", "user": "vibetax" },
  "firstLogin": {
    "type": "self-register-first-user-becomes-admin",
    "url": "/register",
    "note": "First registered user becomes the firm admin. Configure enabled states and verify corpus is downloaded before researchers start using the app."
  },
  "health": "/api/v1/health",
  "ping": "/api/v1/ping",
  "migrations": {
    "command": ["node", "dist/migrate.js"],
    "autoEnvVar": "MIGRATIONS_AUTO"
  },
  "backup": {
    "volumes": ["vibe-tax-research-uploads"],
    "databases": ["vibe_tax_research_db"],
    "skipVolumes": ["vibe-tax-research-corpus"]
  },
  "corpusManagement": {
    "downloadUrl": "https://corpus.kisaes.com",
    "signatureKeyId": "kisaes-corpus-2025",
    "updateCadence": "quarterly"
  }
}
```

The `postgresExtensions` field is a Tax-Research-Chat-specific manifest extension. The appliance's DB-bootstrap step reads it and ensures the extensions are created in the per-app database before the app starts.

The `corpusManagement` block tells the console how to surface corpus updates — the same way `desktopDistribution` tells the Connect manifest to surface a download link.

The `backup.skipVolumes` entry excludes the corpus from regular backups. Reasoning: the corpus is large (~5 GB), reproducible from `corpus.kisaes.com`, and bloats backup destinations needlessly. If the corpus volume is lost, redownload from CDN. Firm overlay documents live in the regular `vibe-tax-research-uploads` volume which IS backed up.

### 5.12 Volume strategy

- `vibe-tax-research-corpus` — federal + state authority corpus + firm overlay. Large (multi-GB). Backup excluded (recoverable from CDN; firm overlay backed up separately).
- `vibe-tax-research-uploads` — firm overlay documents pre-redaction (encrypted at rest). Small. Backed up.

Actually, wait — the firm overlay should be in `uploads`, not `corpus`. Let me clarify:

- `vibe-tax-research-corpus` — read-mostly authority corpus. Reproducible from CDN. Skip backup.
- `vibe-tax-research-uploads` — firm-uploaded documents (originals before redaction). Includes firm overlay source files. Backed up.

When the indexer processes a firm upload, it scrubs PII via Presidio, embeds the scrubbed version, and writes the indexed copy under `corpus/firm-overlay/` for retrieval. The original encrypted upload remains in `uploads/`.

### 5.13 Emergency-access compatibility

**Goal.** All Tax-Research-Chat features work over emergency access (`http://<server-ip>:5191`). Like TB, no client portal or kiosk to break.

**Action — same five items as MyBooks plus one Tax-Research-specific:**

1. Disable HTTPS-redirect inside the app.
2. No `X-Forwarded-Proto: https` requirement.
3. Host header allowlist tolerates IP:port form.
4. Cookies use `secure: 'auto'`.
5. `/api/v1/ping` works without DB/LLM/embeddings dependencies.

**Tax-Research-specific:**

6. **SSE streaming works over plain HTTP.** Same protocol; just `http://` instead of `https://`. HAProxy emergency-proxy config has bumped `timeout server 600s` for the SSE frontend. Verify in test.

**Tests.**

- Kill Caddy, hit `http://<lan-ip>:5191/`. Log in, ask a research question, confirm streaming response works token-by-token.
- Cookie inspection on emergency: session cookie set without `Secure` flag.
- Stop Postgres: `/api/v1/ping` still returns 200; `/api/v1/health` returns 503.
- LLM endpoint goes down during emergency-mode usage: in-flight chat fails gracefully; new chats show "AI temporarily unavailable" banner.

**Standalone impact.** Items 1, 2, 4 improvements; items 3, 5, 6 no-ops in standalone HTTPS.

---

## 6. PR plan

**Three PRs** against `KisaesDevLab/Vibe-Tax-Research-Chat`, in order. Plus the **two upstream items** from §0.

### Upstream (parallel, blockers for integration testing)

- **Parent appliance plan: confirm ParadeDB as shared Postgres image.** Update PLAN.md §1 core compose and §8.2 audit. Half-day work in the appliance repo. Status: **needed** before PR 1 integration testing.
- **Vibe-GLM-OCR addendum: model expansion.** Document loading Qwen3-8B + BGE-M3 + bge-reranker-v2-m3 in addition to GLM-OCR. Update GLM-OCR's manifest and Ollama startup config. Status: **needed** before PR 1 integration testing. Will be the GLM-OCR addendum (the family's last and smallest).

### PR 1: Audit + common-requirements + LLM dependency (sections 3, 5.1, 5.2)

Begins with the 🔍 audit pass — Claude Code reads the repo, fills in the audit table with reality, then writes fixes for what's broken.

- All common-requirements items.
- Hard LLM dependency: `LLM_ENDPOINT`, `LLM_MODEL`, `EMBEDDINGS_ENDPOINT`, `EMBEDDINGS_MODEL`, optional `RERANKER_*`. Required env validation at startup.
- ParadeDB/pgvector check at startup with clear error.
- `/health` includes LLM and embeddings status.
- Streaming SSE working with proper headers.

### PR 2: Corpus + reindex + state config + citations + PII (sections 5.3, 5.4, 5.5, 5.6, 5.7)

The substantive feature PR. Higher review weight.

- Corpus management: distribution, signed updates, firm overlay upload.
- Reindex flow with rolling/atomic-swap and progress tracking.
- Citation verification via Eyecite + custom IRS tokenizers.
- PII redaction via Presidio at query and document time.
- State coverage configuration.

### PR 3: Appliance overlay + manifest + emergency + sessions (sections 5.8, 5.9, 5.10, 5.11, 5.12, 5.13)

The "make it appliance-ready" PR.

- `docker-compose.appliance.yml`.
- `.appliance/manifest.json` with `postgresExtensions`, `corpusManagement`, `streaming: "sse"`.
- Conversation history feature wiring.
- Emergency-access compatibility audits and fixes.
- Volume strategy + backup skip configuration.

After PR 3 merges, the GLM-OCR addendum lands, and the parent ParadeDB confirmation merges, the Vibe-Appliance Phase 5 work for Vibe-Tax-Research-Chat becomes:

1. Drop `apps/vibe-tax-research.yml` overlay in the appliance repo.
2. Drop `env-templates/per-app/vibe-tax-research.env.tmpl`.
3. Implement the appliance console's corpus-update surface (reads `corpusManagement` from manifest).
4. Implement the appliance bootstrap's `--enabled-states` prompt.
5. Test enable Tax-Research-Chat (which auto-enables Vibe-GLM-OCR if not already), full chat flow with citations, corpus update flow on a fresh droplet.

---

## 7. Backward compatibility commitments

Things that must not change for existing standalone customers:

- Existing standalone install path produces a working install on a fresh Ubuntu host (with pgvector + ParadeDB extensions installed) with no env-var changes required, given they configure their own LLM endpoint.
- An existing customer's `.env` file continues to work after upgrade. Deprecated vars produce a single `[deprecated]` log line.
- Default configuration unchanged where it doesn't conflict with new requirements.
- Existing chat conversations and corpus indexes survive upgrade.
- Existing firm-overlay documents survive upgrade (no need to re-upload).

If anything in section 5 violates these, that section is wrong and needs revision.

---

## 8. Out of scope

Things deliberately **not** in this addendum:

- **Multi-state corpus expansion past 8 states.** v1 scope; future addenda can expand.
- **Non-US tax authorities.** Out of scope.
- **Voice query / audio output.** Out of scope.
- **Direct integration with tax prep software** (UltraTax, Lacerte, etc.). Separate concern; future Vibe app.
- **Federated search across multiple firms' tax research.** Privacy and data-sharing implications make this v2+.
- **LLM fine-tuning on firm-specific data.** Way out of scope; the firm overlay is a RAG addition, not fine-tuning.
- **GPU support in Vibe-GLM-OCR.** Inference is CPU-bound by default. GPU is a separate upgrade path; out of scope for v1 appliance.
- **Air-gapped corpus updates with offline tarballs.** Documented as a manual flow; not automated in v1.

---

## 9. Definition of done

This addendum is complete when:

1. The two upstream items in §6 (ParadeDB confirmation, GLM-OCR expansion) are completed.
2. All three PRs are merged.
3. New image tags published to GHCR for both architectures.
4. Standalone install on a fresh Ubuntu 24.04 droplet (with the customer's own pgvector-equipped Postgres and own LLM endpoint) produces a working app — same behavior as before this work, plus the new corpus-management features.
5. Appliance integration test: parent appliance compose with this app's overlay AND Vibe-GLM-OCR enabled brings up Vibe-Tax-Research at `tax.<test-domain>` with all three model endpoints reachable.
6. Corpus fetch test: from a fresh appliance, configure `ENABLED_STATES=ca,ny`, run corpus fetch, verify federal + CA + NY corpora downloaded and indexed within ~30 minutes.
7. Citation verification test: ask 10 known-correct research questions; all responses cite verifiable sources; ask 1 hallucination-prone question; response shows `[citation could not be verified]` rather than silent error.
8. PII redaction test: query containing fake SSN — confirm SSN scrubbed before LLM sees it.
9. Streaming test on all three access methods: tokens stream progressively (no buffering pauses) over Caddy primary, Tailscale, and HAProxy emergency.
10. State management: add Texas via admin UI, verify corpus fetch + reindex completes, queries about Texas now work.
11. Tailscale access test: full chat flow including streaming works on `tax.<test-tailnet>.ts.net`.
12. Emergency-access test: with Caddy stopped, full chat flow including streaming works on `http://<lan-ip>:5191`.
13. The five backward-compat commitments in §7 hold under regression testing.

When that's true, the appliance Phase 5 (Vibe-Tax-Research integration) reduces to the five-step task at the end of §6.

**Tax-Research-Chat is the most architecturally novel Vibe app to integrate**, primarily because of the LLM-coordination story (Tax-Research-Chat ↔ Vibe-GLM-OCR) and the corpus-management UX. Budget ~1 week of focused work for this addendum's PRs, plus the GLM-OCR addendum and the parent ParadeDB confirmation in parallel. The audit-first approach in PR 1 is deliberate — without seeing the actual repo state, this addendum has more guesses in it than the others, and the audit pass converts those guesses into known facts before they cause problems downstream.
