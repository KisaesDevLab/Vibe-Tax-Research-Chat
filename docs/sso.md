# Single sign-on (Vibe Auth) — operator notes

Researchers can sign in to Vibe Tax Research Chat through the firm's **Vibe Auth** identity
provider. The app consumes it as a generic OpenID Connect client through `@kisaesdevlab/vibe-auth`,
the shared Vibe client package: Authorization Code + PKCE, just-in-time user provisioning, Vibe
group → role mapping, back-channel logout, an Admin → **Authentication** page and a break-glass
local admin. The package owns the OIDC flow; everything product-specific lives in
`apps/api/src/lib/vibeAuth.ts` (engine, session adapter, `/auth/*` middleware, local-login
policy) and `apps/api/src/lib/vibeAuthUsers.ts` (user adapter over `users`, audit sink), shared
with the break-glass CLI adapter `apps/api/src/vibeAuthAdapter.ts`.

**Session model.** Sessions stay what they were: a 15-minute access JWT plus a rotating 30-day
refresh row, held by the SPA in localStorage. An SSO login parks the identity (issuer, subject,
IdP session id, ID token) in `auth_sessions_oidc` under a fresh `sid`, lands the browser on
`/login#sso_code=<code>` — a **one-time code, 60 s** — and the SPA exchanges it at
`POST /api/auth/sso/exchange` for exactly the JSON a password login returns. The access token
carries `sid`; every refresh rotation copies it from the refresh row, so the whole chain can be
ended by session. Local login is never removed; SSO is additive (mode `local` by default).

## Modes

| Mode              | Password sign-in           | SSO button | Notes                                                                                                             |
| ----------------- | -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `local` (default) | everyone                   | hidden     | Behaviour before this feature.                                                                                    |
| `both`            | everyone                   | shown      | Recommended while rolling out.                                                                                    |
| `oidc_only`       | **break-glass admin only** | shown      | The API refuses to boot until the break-glass account exists. Turn on `VIBE_OIDC_REQUIRE_MFA_AMR` (no local MFA). |

Switch modes on Admin → Authentication or with `VIBE_AUTH_MODE`. Values saved on the page are
stored in `auth_settings` and **override the environment on every later boot**; the client secret
is wrapped with `MASTER_KEY` (`lib/crypto.ts`, purpose `vibe_auth.client_secret`). Turning on
`oidc_only` needs an existing break-glass account **and** a successful "Test connection" within
the last hour by the same admin.

## Environment

On the Vibe Appliance the console writes the `VIBE_OIDC_*` block after
`sudo vibe identity register vibe-tax-research`. Standalone installs put it in `.env`
(`.env.example` carries the commented block).

| Variable                                                                                  | Meaning                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIBE_AUTH_MODE`                                                                          | `local` \| `both` \| `oidc_only` (above).                                                                                                                                                                                                                            |
| `VIBE_OIDC_ISSUER`                                                                        | Issuer URL of the provider (discovery at `<issuer>/.well-known/openid-configuration`).                                                                                                                                                                               |
| `VIBE_OIDC_INTERNAL_BASE`                                                                 | Container-to-container base for discovery / token / JWKS calls when the public issuer is not reachable from inside the stack.                                                                                                                                        |
| `VIBE_OIDC_CLIENT_ID`, `VIBE_OIDC_CLIENT_SECRET`                                          | From the registration.                                                                                                                                                                                                                                               |
| `VIBE_OIDC_PUBLIC_URL`                                                                    | This app's public URL **including its prefix** (`https://host/tax` in multi-app mode). Redirect URI: `<public URL>/auth/oidc/callback`; back-channel: `<internal URL>/auth/oidc/backchannel`. Falls back to Admin → Settings → App base URL, then `PUBLIC_BASE_URL`. |
| `VIBE_OIDC_REQUIRE_MFA_AMR`                                                               | Refuse an SSO login whose `amr` claim shows no second factor. Recommended — this product has no local MFA.                                                                                                                                                           |
| `VIBE_OIDC_ROLE_MAP`                                                                      | JSON, IdP group → `admin` / `user` / `viewer`. Default: `vibe-admin`, `vibe-it`, `vibe-partner` → `admin`; `vibe-manager`, `vibe-staff` → `user`.                                                                                                                    |
| `VIBE_OIDC_DEFAULT_ROLE`, `VIBE_OIDC_ALLOW_JIT`, `VIBE_OIDC_IDP_NAME`, `VIBE_OIDC_SCOPES` | Package options; see the package README.                                                                                                                                                                                                                             |
| `VIBE_BREAKGLASS_USERNAME`                                                                | Default `vibe-breakglass`. `VIBE_BREAKGLASS_PASSWORD` is read only by the CLI when provisioning.                                                                                                                                                                     |

Users provisioned just-in-time get an unusable random password hash and no spend cap; an existing
user with the same **verified** email is linked instead, and the role is re-synced from the IdP
groups on every login. A soft-deleted user's email resolves to "inactive", never to a new account.

**Role map.** The default map is written out in `VIBE_TRC_ROLES.defaultRoleMap`
(`lib/vibeAuthUsers.ts`) and pinned by a unit test — never the package's guess, which falls back to
the _least_ privileged role (`viewer`) for a group it cannot match. Only `users.role` is written;
spend caps and `can_override_model` are per-user settings that role sync never touches.

**Role sync never demotes the last active admin.** Sync also runs on the _first_ SSO sign-in of an
existing local account, and the admin who ran `/setup` often maps to a lower group. If the write
would leave no other active admin — **the break-glass row does not count as one** — it is skipped:
the sign-in succeeds, the person keeps `admin`, and the `vibe.auth.role.changed` audit row carries
`refused: true, reason: "last_admin"`. Promote a second admin (or map the person's group to `admin`)
and the next sign-in applies the role. The break-glass row itself is never re-roled
(`reason: "breakglass"`).

## SSO-only accounts and password reset

An account created by just-in-time provisioning has `users.has_local_password = false`: it never
held a password anybody knows. For such an account, **and for the break-glass admin**,
`POST /api/auth/forgot-password` answers the same `{ "ok": true }` an unknown address gets, sends
nothing and mints no token; the `auth.forgot_password.request` audit row records
`eligible: false, refused: "sso_only" | "breakglass"`. Otherwise whoever can read the mailbox could
mint a local credential for an account the identity provider governs — and keep using it after the
IdP disables the person (in `local`/`both`; `oidc_only` refuses the password anyway).
`POST /api/auth/reset-password` enforces the same rule at redemption (`auth.password_reset.refused`).
This product has no magic-link sign-in.

An **admin** can still give an SSO-only account a local password — Admin → Users → Set password, or
Send reset email (the admin-sent token is honoured). Either one sets `has_local_password = true`,
after which the account is an ordinary local account as far as reset is concerned. A local user who
was _linked_ by verified email keeps the password they already had and can reset it as before.

## Paths and proxies

The engine is created with `basePath: ""` and answers `/auth/*` on the API, outside `/api`. Every
deployment strips the SPA prefix before the API sees a request (the Vite dev proxy, the web image's
nginx, the appliance Caddy), while the React components get the prefix from
`import.meta.env.BASE_URL`; the redirect URI is always built from `VIBE_OIDC_PUBLIC_URL`, never from
`basePath`. **Every proxy in front of the API must route `/auth/*` like `/api/*`** —
`apps/web/nginx.conf` and `apps/web/vite.config.ts` do; on the appliance the manifest's `auth`
matcher does.

| Route                                                | Purpose                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/status`                                   | Mode, whether SSO is enabled / reachable, the start path. Unauthenticated; the login page reads it.                                             |
| `GET /auth/oidc/start[?return_to=]`                  | Begin the PKCE login.                                                                                                                           |
| `GET /auth/oidc/callback`                            | Provider redirect; ends on `<return_to>#sso_code=<code>`.                                                                                       |
| `POST /api/auth/sso/exchange` `{code}`               | Claims the one-time code (atomic, single use) and returns `{access_token, refresh_token, user}`.                                                |
| `GET /auth/oidc/logout[?local=1]`                    | RP-initiated logout (bearer). Without `local=1` the browser is sent to the provider's end-session endpoint and back to `/auth/oidc/logged-out`. |
| `POST /auth/oidc/backchannel`                        | Provider back-channel logout (form `logout_token`). Ends every matching session — see below.                                                    |
| `GET /auth/me`                                       | The engine's view of the current user and linked identities (bearer).                                                                           |
| `GET/PUT /auth/settings`, `POST /auth/settings/test` | Admin → Authentication API, admins only (bearer).                                                                                               |
| `/login/local`                                       | Hidden SPA route that keeps the password form visible in `oidc_only` (break-glass).                                                             |

Only `GET /auth/oidc/start?test=1` — the settings page's test-connection popup, a plain navigation —
may authenticate with the `vibe_at` cookie; every other `/auth/*` route is bearer-only (a Lax cookie
honoured on the logout route would be a logout-CSRF). The browser-driven steps (`start`,
`callback`, `settings/test` and `POST /api/auth/sso/exchange`) are rate-limited at 100 per
15 minutes per address (not the 5-per-window password limiter); the back-channel endpoint is not,
because the provider posts from one address for every user.

## Break-glass account

`vibe-breakglass` is a local admin with a password only, the one account that may sign in locally
while the mode is `oidc_only`; the server refuses to start in that mode if it is missing or
inactive. `users` has no username column, so the row's email is
**`vibe-breakglass@vibe-tax.local`** (not `@localhost` — the login route's email validator wants a
TLD).

**Signing in.** At `/login/local` (`/tax/login/local` in multi-app mode), type **either** the
username the Appliance prints — `vibe-breakglass` — **or** the address
`vibe-breakglass@vibe-tax.local`; the password is the one printed once at registration (on the
Appliance: `VIBE_BREAKGLASS_PASSWORD_VIBE_TAX_RESEARCH` in `/opt/vibe/env/vibe-auth.env` and
`CREDENTIALS.txt`). `POST /api/auth/login` admits that one literal besides email addresses, and the
sign-in form's identifier field is a plain text field so the browser does not reject it. Either
spelling reaches the engine as the username, so `oidc_only` lets it through and
`vibe.auth.breakglass.used` is audited.

**Second factor: none.** This product has no local MFA of any kind (no TOTP, no email codes), so
break-glass is **password only** — the ~32-character random password generated by the CLI is its
whole protection, together with the 5-per-15-minutes login limiter and the audit row on every use.
That is deliberate for an outage account (nothing to enrol, nothing that needs SMTP), and it is why
`VIBE_OIDC_REQUIRE_MFA_AMR=true` is recommended: day-to-day accounts get their second factor at the
identity provider. Note the login limiter lives in Redis; with Redis down, password sign-in —
break-glass included — is unavailable.

**Protection.** In **every** mode (not only `oidc_only` — the mode can be flipped later, and the
API then refuses to boot without the account) Admin → Users answers `409 breakglass_protected` to
disabling, demoting or deleting the break-glass row and to sending it a reset email, and to
creating an ordinary account on its reserved address; refused attempts are audited as
`admin.user.breakglass_protected`. Its address cannot be changed (no user's can — `PATCH` has no
email field). Self-service reset is refused (above), role sync never re-roles it, and it is not
counted as "another admin" by last-admin protection. Admin → Users → Set password _does_ work on
it, but the Appliance's stored copy then goes stale — rotate instead
(`sudo vibe identity rotate-breakglass vibe-tax-research`, or the CLI below).

Provision or rotate it with the package CLI, which finds this app's users through
`apps/api/src/vibeAuthAdapter.ts`:

```bash
# from a source checkout, with the API's env (.env at the workspace root)
pnpm --filter @vibe/api vibe-auth breakglass ensure | rotate | status

# inside the published image (WORKDIR is /app; VIBE_AUTH_ADAPTER is baked in by the Dockerfile)
docker exec -i vibe-tax-api node apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass status
```

`ensure` prints the generated password **once** (`--json` for machines) and is idempotent — an
inactive or soft-deleted account is reactivated with a fresh password. Provisioning and every
break-glass sign-in are audited (`vibe.auth.breakglass.rotated` / `vibe.auth.breakglass.used`).

## Registration

On the appliance nothing is registered by hand: `lib/identity.sh` reads the manifest's `sso` block,
registers the product with the Vibe Auth broker, writes the returned `VIBE_OIDC_*` block into
`/opt/vibe/env/vibe-tax-research.env`, recreates the container and provisions the break-glass admin.
After changing the `sso` block, re-register with `sudo vibe identity register vibe-tax-research`; a
rebuilt image alone does not.

The appliance reads its **vendored** copy, `Vibe-Appliance/console/manifests/vibe-tax-research.json`
— it still lacks the SSO fields. Add these to it (keeping its existing `api` matcher):

```jsonc
"requires": ["identity"],
"routing": { "default_upstream": "vibe-tax-web:80",
  "matchers": [ { "name": "api",    "path": "/api/*",          "upstream": "vibe-tax-api:4000", "streaming": true },
                { "name": "queues", "path": "/admin/queues/*", "upstream": "vibe-tax-api:4000" },
                { "name": "auth",   "path": "/auth/*",         "upstream": "vibe-tax-api:4000" } ] },
"sso": { "capable": true, "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"],
  "publicPaths": ["/api/health","/api/health/deep","/api/ping","/api/setup/*","/api/webhooks/*","/api/dl/*",
                  "/api/auth/login","/api/auth/refresh","/api/auth/sso/exchange","/api/auth/forgot-password",
                  "/api/auth/reset-password","/login/local"],
  "edgeGate": false, "internalUrl": "http://vibe-tax-api:4000",
  "breakglassService": "vibe-tax-api",
  "breakglassCommand": ["node","apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js","breakglass","ensure","--json"] }
```

and `VIBE_OIDC_REQUIRE_MFA_AMR=true` to `env-templates/per-app/vibe-tax-research.env.tmpl`.

**Until the vendored copy carries that block, registration looks successful but provisions no
break-glass admin**: the Appliance falls back to `docker exec vibe-tax-research-server npx vibe-auth …`
(a container that does not exist here) and swallows the failure. After every `register`, check:

```bash
docker exec -i vibe-tax-api node apps/api/node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass status
# → {"exists":true,"active":true,"role":"admin",…}
```

and sign in once at `/tax/login/local` as `vibe-breakglass` with the stored password **before**
switching the mode to `oidc_only`. The Appliance only checks that a password string is stored, not
that it works; after restoring an older database, run `sudo vibe identity rotate-breakglass
vibe-tax-research` to bring the two back in line.

On a standalone install register the product with the broker yourself:

```http
POST <vibe-auth>/vibe-auth/registrations
{ "slug": "vibe-tax-research", "displayName": "Vibe Tax Research Chat",
  "baseUrl": "https://host/tax", "internalUrl": "http://vibe-tax-api:4000",
  "redirectPaths": ["/auth/oidc/callback"], "logoutPaths": ["/auth/oidc/backchannel"] }
```

and put the returned env block into the API's environment. With any other OpenID Connect provider,
register the redirect URI `<public URL>/auth/oidc/callback` and the back-channel logout URI
`<internal URL>/auth/oidc/backchannel`.

## Migration, audit, revocation

- `packages/db/drizzle/0022_vibe_auth.sql` creates `auth_identities`, `auth_settings`,
  `auth_revocations` (the package's tables; `user_id` is a real FK onto `users` here) and this
  app's `auth_sessions_oidc`, and adds `auth_refresh_tokens.sid`;
  `0023_sso_local_password.sql` adds `users.has_local_password` (default `true`; only JIT
  provisioning writes `false`). Applied on boot with `MIGRATIONS_AUTO=true` like every migration.
- A DR restore onto a server with a different `MASTER_KEY` re-keys the wrapped client secret in
  `auth_settings` alongside the `settings` rows (`rekeySecrets`, `lib/backup/engine.ts`), so SSO
  keeps working after the swap; a secret that will not unwrap under the archive key is reported as
  `auth_settings:<key>` in `verify.rekeyFailures` and must be re-entered on Admin → Authentication.
- Every package event is one `audit_log` row: `action = vibe.auth.*` (login success/failure, user
  provisioned/linked, role changed, logout, mode/settings changed, break-glass used/rotated),
  `target_type = 'auth'`, the user id in `target_id`, the payload as `metadata`.
- **Sign-out** (`POST /api/auth/logout`) on an SSO-born session deletes the identity row, revokes
  the refresh chain by `sid` and revokes the access token through `auth_revocations`, so it dies
  immediately instead of at its 15-minute expiry.
- **Back-channel logout** revokes by user (a logout token naming a subject signs that person out
  of the product entirely — local-password sessions included) and by every internal session id it
  ends (a `sid`-only token ends only the matching sessions). `requireAuth` consults the list on
  **every** request and `POST /api/auth/refresh` on every rotation, so the SPA cannot re-mint a
  session the identity provider ended. A later login stays valid; records self-expire after 24 h.
  A login minted in the same second as a user-level revocation is rejected (fail-closed; the OIDC
  round trip takes longer than that in practice).

## Building from source

`@kisaesdevlab/vibe-auth` is served from GitHub Packages, which refuses anonymous reads even for
public packages. Pulling the published images needs nothing. Building yourself:

- **Developers** need a GitHub token with `read:packages` in `~/.npmrc`:
  `//npm.pkg.github.com/:_authToken=<token>` (with the GitHub CLI signed in, `gh auth token`).
  The repo's `.npmrc` only maps the `@kisaesdevlab` scope to the registry; the token is never committed.
- **Docker** takes the token as a BuildKit secret that never lands in a layer:
  `docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -f apps/api/Dockerfile --target runtime .`
  (and the same for `apps/web/Dockerfile` — the SPA embeds the package's React components).
- **GitHub Actions** (`release.yml`, `sso-e2e.yml`) use `GITHUB_TOKEN`, which can read the package
  once the package grants this repository access: Vibe-Auth → Packages → `vibe-auth` → Package
  settings → _Manage Actions access_ → add `Vibe-Tax-Research-Chat` (read).

## Testing

- `pnpm test:sso-e2e`: boots the real API against a scratch database on the dev compose Postgres
  (`:5439`) and a scratch Redis logical database (`:6389`), with the fake OpenID provider in
  `test/fake-idp.mjs`, and walks status in `local`/`both`, PKCE login → hand-off → exchange → JIT
  with the mapped role, email link + role sync, unverified email denied, `/auth/settings` 403/200,
  the `oidc_only` guard, break-glass CLI + local login + audit, back-channel revocation (user-level
  and sid-only), sign-out revoking the access token, a fresh login after revocation, RP-initiated
  logout and boot refusal without break-glass. Runs in CI (`.github/workflows/sso-e2e.yml`). It
  does not yet cover the bare-username sign-in, the `breakglass_protected` refusals or the reset
  refusals; the unit suites below do.
- `pnpm --filter @vibe/api test` covers the adapters (pinned role map, last-admin role-sync guard),
  the hand-off rewrite, the revocation hook, the login policy, the reset refusals and the Admin →
  Users break-glass protection with the mocked-drizzle pattern; `pnpm --filter @vibe/web test`
  covers the fragment hand-off and the username-capable identifier field on the login page.
- Against a real provider: the Vibe-Auth repo's `test/compose.yml` stack (authentik), then
  Admin → Authentication → Test connection.

## Deviations from the Vibe-Auth integration plan (`Vibe-Auth/docs/integration-plans/vibe-tax-research-chat.md`)

1. **A one-time code on the fragment, not the tokens.** The plan lands on
   `#sso_token=<access>&sso_refresh=<refresh>`; a 30-day refresh token in a URL is a worse trade
   than Trial Balance's 8-hour token. The code is single-use, 60 s, sha256-stored, and
   `POST /api/auth/sso/exchange` returns the login JSON.
2. **`sid` on the refresh row, not in the refresh JWT.** Rotation copies it; the refresh JWT stays
   `{sub, jti}`.
3. **Revocation keys.** The engine's back-channel writes `s:<IdP sid>`, which can never match our
   tokens (their `sid` is our own id); `destroyByIdentity` revokes the internal sids itself, and a
   local sign-out revokes its own sid so the access token dies at once.
4. **Cookie acceptance on `/auth/*` is limited to the test-connection popup** (`GET
/auth/oidc/start?test=1`); the plan's TB reference does the same, the checklist's default
   `currentUserId` would honour it everywhere.
5. **Break-glass email `vibe-breakglass@vibe-tax.local`**, not `@localhost`; the login route also
   admits the literal username.
6. **No `guardLocalLogin` middleware from the package** (rule I5): `localLoginRefusal` keeps this
   API's `{error}` envelope.
7. **Token minting was consolidated** (`lib/sessions.ts`): the previous insert-`'pending'`-then-update
   pattern collided on the UNIQUE `token_hash` under concurrent logins.
