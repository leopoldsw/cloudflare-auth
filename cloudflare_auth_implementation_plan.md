# Cloudflare Auth — Implementation-Ready Plan for AI Coding Agents

**Date:** May 13, 2026  
**Status:** Implementation-ready specification  
**Target outcome:** A polished open-source GitHub repo that can be installed, tested, deployed, and consumed as packages by Cloudflare Workers developers.  
**Working project name:** Cloudflare Auth  
**Default auth route:** `/auth`  
**Primary package scope:** `@cf-auth/*`  
**CLI binary:** `cf-auth`

**Project affiliation:** Independent open-source project; not affiliated with, endorsed by, or sponsored by Cloudflare.

This document is the source of truth for implementation. It is written as an execution contract for coding agents and maintainers, with implementation rationale captured in footnotes so future contributors understand why the boundaries exist.

---

## 0. Agent Execution Contract

AI coding agents must treat this document as a build spec, not as brainstorming notes.

### 0.1 Non-negotiable implementation rules

Do not ship code that violates these rules:

1. **No raw session token in D1.** Store only HMAC-hashed session tokens.
2. **No raw email token in D1.** Store only HMAC-hashed magic-link, email-verification, and password-reset tokens.[^token-storage]
3. **No password hash without algorithm, version, and parameters.** Password hashes must use versioned envelopes.[^password-envelope]
4. **No unsafe redirect.** Redirect targets must be validated and stored when the token is created.[^stored-redirects]
5. **No token-consuming `GET` links for magic login or email verification.** `GET` renders a confirmation page; `POST` consumes.[^post-consume]
6. **No production or preview terminal email.** Terminal email and dev outbox are development-only surfaces.[^terminal-email]
7. **No Cloudflare Email dependency for local dev.** Local quickstart must work with terminal email.
8. **No account-existence leak in magic-link, password-reset, or email-verification request endpoints.** Always return `{ "ok": true }` for those request flows and apply the timing-hardening requirements in Section 28.2.[^enumeration-timing]
9. **No request `Host` header as the source of emailed links in preview or production.** Use configured `publicOrigin`.[^public-origin]
10. **No `__Host-` cookie on plain local HTTP.** Use an unprefixed dev cookie on `http://localhost`.[^cookie-prefix]
11. **No global permissive CORS in front of auth routes.** Auth routes must enforce their own CORS/CSRF model.[^cors-csrf]
12. **No raw or ambiguous email/IP/user-agent values in rate-limit keys or auth event hashes.** Use derived HMAC keys namespaced by action and subject type.[^pii-hashing][^rate-limit-key-namespace]
13. **No route path double-prefixing.** `createAuthRoutes()` defines relative routes only; the app mounts it at `authConfig.basePath`.[^route-boundary]
14. **No string-interpolated SQL.** Use prepared statements and bound parameters.
15. **No silent platform assumptions.** `doctor` must detect missing D1 bindings, unapplied migrations, missing secrets, cookie misconfiguration, and production email/link configuration issues.[^doctor]
16. **No unbounded request bodies.** Auth handlers must reject bodies larger than the configured limit before parsing JSON or form data.[^body-limit]
17. **No unbounded password hashing concurrency.** Password hashing must run behind a small per-isolate concurrency guard.[^hash-concurrency]
18. **No raw token leakage in logs, errors, telemetry, or preview output.** All logging paths must use the shared redactor.[^log-redaction]
19. **No ambiguous runtime configuration.** Static config validation and request-time environment resolution must be separate.[^runtime-config]
20. **No unsupported cross-site cookie auth in v1.** Credentialed cross-site CORS and `SameSite=None` are rejected unless a future CSRF implementation is explicitly added.[^same-site]
21. **No password-reset token-consuming `GET` route.** `GET` renders the reset form; `POST` confirms the new password and consumes the token.[^reset-page]
22. **No duplicate auth-secret key IDs.** The current and previous key ring must reject repeated `kid` values.[^key-ring-kids]
23. **No production request from an untrusted host.** Production auth requests must be host-validated before route handling, link generation, redirect handling, or cookie decisions.[^host-validation]
24. **No production deploy from ambiguous Wrangler environment config.** Production deploys must use a named environment or an explicitly production top-level config, with all non-inheritable bindings and vars present for that environment.[^wrangler-environments]
25. **No security decision from stale D1 replicas.** Session, token, disabled-user, and password-reset decisions must use primary-consistent reads or write-guarded transactions.[^primary-auth-reads]
26. **No invalid verification-token subject rows.** Every token row must have a valid user/email subject shape for its token type.[^token-subject-invariant]
27. **No request-origin and redirect-origin conflation.** CORS/CSRF request origins and post-auth redirect origins are separate allowlists.[^origin-vs-redirect]
28. **No repository-generated raw auth tokens.** Repository functions accept already-derived token hashes and session fields; token services generate raw tokens and keep them out of persistence logs.[^repo-token-boundary]

### 0.2 Implementation order

Implement the stages in Section 30 in this exact order unless a maintainer updates this specification:

1. **Stage 0 — Repo identity and documentation skeleton.**
2. **Stage 1 — Monorepo and tooling.**
3. **Stage 2 — D1 migrations, repositories, and rate-limit storage.**
4. **Stage 3 — Crypto, passwords, tokens, and sessions.**
5. **Stage 4 — Auth HTTP runtime.**
6. **Stage 5 — Email adapters and templates.**
7. **Stage 6 — Hono, plain Worker, and client SDK.**
8. **Stage 7 — CLI MVP.**
9. **Stage 8 — Examples and docs.**
10. **Stage 9 — Security hardening.**
11. **Stage 10 — Private alpha.**
12. **Stage 11 — Public beta.**
13. **Stage 12 — 1.0 readiness.**

Stage deliverables and acceptance criteria are authoritative. Later-stage features may be mentioned earlier for context, but an earlier stage may only depend on code, tests, configuration, docs, and contracts delivered in that stage or a previous stage.

### 0.3 Do not implement in v1

Purpose: this section is a scope and threat-model boundary, not a feature backlog. Each listed area adds separate security, recovery, migration, and support requirements. Keeping them out of v1 keeps the core auth runtime small enough to audit, test, and operate safely.[^non-goals]

Do not implement these unless the task explicitly says this spec has changed:

- OAuth/social login
- SAML/enterprise SSO
- passkeys
- MFA
- organizations/teams
- role/permission framework
- hosted dashboard
- hosted auth service
- billing integration
- admin impersonation
- multi-project control plane
- password peppering

Rationale for v1 exclusions:

| Excluded area | Rationale |
|---|---|
| OAuth/social login | Requires provider-specific flows, account linking, callback hardening, and provider outage handling. |
| SAML/enterprise SSO | Requires enterprise metadata lifecycle, certificate rotation, organization policy, and support workflows. |
| Passkeys and MFA | Require recovery flows, device lifecycle handling, step-up semantics, and additional threat modeling. |
| Organizations, teams, roles, and permissions | These are authorization features, not core authentication primitives. |
| Hosted dashboard, hosted auth service, and multi-project control plane | These turn the project into a SaaS/control-plane product instead of a self-deployed library. |
| Billing integration | Adds product/business logic unrelated to the auth runtime. |
| Admin impersonation | High-risk feature that requires audit trails, approvals, and strong safeguards. |
| Password peppering | Adds another secret lifecycle and rotation path; v1 keeps password verification tied to explicit hash envelopes and root auth-secret handling. |

---

## 1. Executive Decisions

### 1.1 Product strategy

Build a small, secure, self-deployed auth runtime for Cloudflare-native applications, with a first-class CLI that hides most Cloudflare setup complexity while still using Cloudflare-native primitives.

### 1.2 Wrangler decision

**Decision:** `cf-auth` wraps Wrangler. It does not replace Wrangler.

Rules:

- `@cf-auth/cli` must depend on a compatible Wrangler version or resolve a compatible local installation.
- `cf-auth` must print the underlying Wrangler command in verbose mode.
- End-user docs must teach `cf-auth` first and Wrangler second.
- Advanced docs may show raw Wrangler commands only for debugging and must label them as secondary to `cf-auth`.
- `doctor` must verify Wrangler availability, version compatibility, Cloudflare login/account state, D1 config, migrations, secrets, email config, route mode, cookie settings, and named-environment binding/var completeness.

### 1.3 CLI/package naming decision

The user-facing command is:

```bash
npx cf-auth@latest init
```

To make that command work, publish an unscoped shim package named `cf-auth` with a `cf-auth` binary. The shim must delegate to `@cf-auth/cli`.

Packages:

| Package | Purpose |
|---|---|
| `cf-auth` | Thin unscoped CLI shim so `npx cf-auth@latest ...` works. |
| `@cf-auth/cli` | Real CLI implementation. |
| `create-cloudflare-auth` | `npm create cloudflare-auth@latest my-app`. |
| `@cf-auth/core` | Pure auth logic and contracts. |
| `@cf-auth/worker` | Cloudflare Worker runtime. |
| `@cf-auth/hono` | Hono adapter. |
| `@cf-auth/client` | Browser SDK. |
| `@cf-auth/email-cloudflare` | Cloudflare Email adapter. |
| `@cf-auth/testing` | Test helpers. |

Release blocker:

- The `@cf-auth/*` npm scope must be controlled by the maintainers before public docs use scoped package imports. If the scope is unavailable, use the approved fallback scope `@cloudflare-auth/*` and update every package name, import, quickstart, generated template, and package-boundary test consistently before publication.
- If the unscoped `cf-auth` package name is unavailable, update all public docs to use `npx --package @cf-auth/cli@latest cf-auth init`. Do not publish docs that say `npx cf-auth` unless the package exists.[^scoped-npx]
- If the unscoped `create-cloudflare-auth` package name is unavailable, update new-app quickstarts to use `npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic` and remove `npm create cloudflare-auth` from public docs until the create package exists.

### 1.4 MVP decisions

| Area | Decision |
|---|---|
| Product model | Self-deployed OSS package, not SaaS. |
| Default deployment | Embedded auth routes inside the app Worker. |
| Later deployment | Dedicated auth Worker under the same origin, then service-binding mode. |
| Frameworks | Hono and plain Workers first. Other frameworks are roadmap-only unless added by a later spec. |
| Database | Cloudflare D1 only in v1. |
| Sessions | Opaque D1-backed session cookies, not JWTs.[^no-jwt] |
| Email | Terminal email locally; Cloudflare Email adapter for production; custom email adapter interface. |
| Password hashing | `node:crypto` `scrypt` with versioned hash envelopes and Worker benchmarks. |
| Token storage | Store only HMAC-hashed tokens. Never store raw tokens. |
| Router | Hono adapter plus plain Worker handler. |
| CLI | First-class product surface. |
| License | Apache-2.0. |

---

## 2. Product Definition

Cloudflare Auth is a self-deployed authentication kit for Cloudflare-native applications. It is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Cloudflare.

It gives small teams and solo developers a Supabase Auth-like developer experience without a hosted auth service. The developer owns the Worker, D1 database, email configuration, secrets, and user data inside their own Cloudflare account.

### 2.1 Core promise

Developers should be able to add email/password, username/password, magic links, email verification, password reset, secure cookie sessions, route protection, D1 migrations, and local email previews with minimal Cloudflare setup knowledge.

The product is the combined experience of:

- CLI scaffolding
- D1 provisioning and migrations
- safe default config
- local dev emails
- production deploy flow
- Hono/plain Worker adapters
- browser SDK
- examples
- precise troubleshooting

### 2.2 Intended users

Cloudflare Auth is for developers building:

- small SaaS MVPs
- internal tools
- side projects
- Workers APIs
- Hono apps
- lightweight full-stack Workers apps
- Cloudflare-hosted frontends with API Workers

### 2.3 MVP scope

The MVP must include:

- email/password signup
- optional username/password signup and login
- login with email or username + password
- magic link login
- email verification
- password reset
- current user endpoint
- logout
- secure HTTP-only opaque session cookies
- D1 migrations
- D1-backed user/session/token tables
- terminal-printed local dev email links
- D1 fallback rate limiting, including token-consume endpoints
- Hono route mounting
- plain Worker handler
- browser client SDK
- CLI `init`, `migrate`, `doctor`, `deploy`, `generate`, `clean`, `rotate-secret`, and account recovery helpers
- example apps
- polished README and docs

---

## 3. Platform Assumptions Verified May 13, 2026

Re-check these before public beta and 1.0.

- Wrangler is the Cloudflare Developer Platform CLI for Workers projects.
- D1 migrations are SQL migration files listed and applied through Wrangler.
- D1 Worker bindings expose `prepare`, `batch`, `exec`, and `withSession`.
- D1 `batch()` executes statements sequentially as a transaction and rolls back the sequence if a statement fails.
- D1 `withSession("first-primary")` directs the first query to the primary database instance and gives subsequent queries sequential consistency.
- Cloudflare Email Service Email Sending supports outbound transactional email through Workers `send_email` bindings, is available on Workers Paid, and is in public beta at the time of this spec. The structured `env.EMAIL.send({...})` Workers API is the primary v1 adapter target; the legacy `EmailMessage` MIME API is supported by Cloudflare but is not the default adapter path.
- Workers Rate Limiting API is GA, requires Wrangler `4.36.0` or later for the binding workflow, is local/permissive/eventually consistent, and supports simple periods of `10` or `60` seconds. It is not an authoritative replacement for D1 rate limits on account-sensitive flows.
- Workers Node.js compatibility requires `nodejs_compat` and a compatibility date of `2024-09-23` or later for current Node compatibility behavior.
- `node:crypto` is supported in Workers when Node.js compatibility is enabled, with documented exceptions that do not affect HMAC or scrypt.
- Cloudflare Workers Vitest integration runs tests inside the Workers runtime.
- Turnstile requires server-side validation; tokens expire and are single-use.
- `npx` executes binaries from packages supplied by the package spec or `--package`. A binary named `cf-auth` does not make `npx cf-auth` work unless the `cf-auth` package or a local binary is available.
- Wrangler bindings and variables, including `vars`, D1 bindings, email bindings, and rate-limit bindings, are non-inheritable across named environments and must be declared in each named environment that uses them.[^wrangler-environments]
- D1 enforces foreign keys by default. Future migrations that temporarily violate foreign-key order must use `PRAGMA defer_foreign_keys = on` instead of relying on `PRAGMA foreign_keys = off`.[^d1-migration-fks]
- `__Host-` cookies require `Secure`, HTTPS, `Path=/`, and no `Domain` attribute. Do not use the `__Host-` prefix for plain local HTTP.
- OWASP recommends slow password hashing with unique salts, and lists scrypt `N=2^17, r=8, p=1` as the recommended minimum where feasible. Workers constraints require benchmarking and documented tradeoffs.[^password-worker-profile]
- Workers isolate memory and CPU budgets make password hashing a capacity-sensitive operation; production deployments must benchmark their configured profile and use a concurrency limiter.[^hash-concurrency]

Source URLs are listed in [Section 34](#34-source-notes).

---

## 4. End-to-End User Experience

### 4.1 New app quickstart

```bash
npm create cloudflare-auth@latest my-app
cd my-app
npm run dev
```

Expected result:

- Hono + Worker app starts locally.
- Local D1 database is available.
- Auth routes are mounted at `/auth/*`.
- Signup/login forms work in the example UI.
- Magic links, verification links, and reset links are printed in the terminal.
- No production email provider is required.
- Dev cookie is unprefixed and works on `http://localhost`.

### 4.2 Existing app quickstart

```bash
npx cf-auth@latest init
npx cf-auth@latest migrate --local
npm run dev
```

Expected result:

- Existing Hono or plain Worker app gets `auth.config.ts`.
- Wrangler config gets an auth D1 binding if missing.
- Migrations are copied or referenced.
- The app gets a route mount snippet.
- Local terminal email is enabled by default.
- `doctor` explains remaining work.

Fallback command if the `cf-auth` package name is unavailable:

```bash
npx --package @cf-auth/cli@latest cf-auth init
```

### 4.3 Production deploy path

```bash
npx cf-auth@latest doctor --env production
npx cf-auth@latest migrate --remote --env production
npx cf-auth@latest deploy --env production
```

or:

```bash
npx cf-auth@latest deploy --migrate --env production
```

Expected result:

- `doctor` runs first.
- D1 migrations are applied.
- Required secrets exist.
- Production `publicOrigin` is configured.
- Cookie config matches deployment mode.
- Worker deploys through Wrangler.
- CLI prints deployed auth endpoints and any remaining external Cloudflare Email/DNS setup steps.

### 4.4 Future one-line production path

This command is not a v1 requirement and must not appear in public quickstarts until it is implemented and tested:

```bash
npm create cloudflare-auth@latest my-app -- --deploy
```

When a later spec enables it, the command must:

1. scaffold the app;
2. install dependencies;
3. create or provision D1;
4. generate local and remote secrets;
5. run local migrations;
6. run remote migrations only when an explicit deployment environment is selected;
7. deploy through Wrangler;
8. print any Cloudflare Email/DNS steps that cannot be automated.

Cloudflare browser login may still be required.

---

## 5. Deployment Architecture

### 5.1 MVP architecture: embedded route

```text
Browser / Frontend
        |
        | same-origin HTTP-only cookie
        v
Cloudflare Worker App
        |
        | /auth/* handled by Cloudflare Auth
        v
Cloudflare D1
        |
        v
Email adapter
  - terminal adapter locally
  - Cloudflare Email Service adapter in production
  - custom adapter when needed
```

Reasons:

- same-origin cookies by default
- no CORS requirement for quickstart
- fewer DNS/routing issues
- simpler local development
- simpler protected route helpers

### 5.2 Later architecture: dedicated auth Worker

```text
example.com/*       -> app Worker
example.com/auth/*  -> auth Worker
```

This keeps same-origin cookie behavior while separating the auth runtime.

### 5.3 Later architecture: service binding mode

```text
App Worker
   |
   | service binding
   v
Auth Worker
   |
   v
D1 + Email adapter
```

Service binding mode is useful for advanced users. It is not required for v1.

---

## 6. GitHub Repo Structure

Use a pnpm monorepo.

```text
cloudflare-auth/
  .github/
    workflows/
      ci.yml
      release.yml
      examples.yml
      dependency-review.yml
      codeql.yml
    ISSUE_TEMPLATE/
      bug.yml
      feature-request.yml
      security-contact.md

  packages/
    cf-auth-shim/
      src/index.ts
      package.json              # package name: cf-auth

    core/
      src/
        config/
        crypto/
        errors/
        ids/
        normalization/
        password/
        rate-limit/
        repositories/
        sessions/
        tokens/
        users/
      package.json

    worker/
      src/
        bindings.ts
        cookies.ts
        createAuthHandler.ts
        headers.ts
        http.ts
        email/
          terminalEmail.ts
        routes/
        security/
        validation/
      package.json

    hono/
      src/
        createAuthRoutes.ts
        getAuthUser.ts
        optionalUser.ts
        requireUser.ts
        requireVerifiedUser.ts
        types.ts
      package.json

    client/
      src/
        browser.ts
        errors.ts
        types.ts
      package.json

    cli/
      src/
        commands/
          init.ts
          migrate.ts
          deploy.ts
          doctor.ts
          generate.ts
          rotateSecret.ts
          clean.ts
          users.ts
          sessions.ts
        cloudflare/
          wrangler.ts
          d1.ts
          secrets.ts
          account.ts
        project/
          detect.ts
          patchWranglerConfig.ts
          patchRoutes.ts
          packageManager.ts
        templates/
        index.ts
      package.json

    create-cloudflare-auth/
      src/index.ts
      package.json

    email-cloudflare/
      src/
        cloudflareEmail.ts
        templates.ts
        types.ts
      package.json

    testing/
      src/
        createTestEnv.ts
        createTestUser.ts
        migrations.ts
        mockEmailAdapter.ts
      package.json

  examples/
    hono-basic/
    worker-basic/
    react-vite-worker/

  migrations/
    0001_initial.sql
    0002_indexes.sql

  docs/
    decisions/
      package-naming.md
    non-goals.md
    quickstart.md
    existing-hono-app.md
    existing-worker-app.md
    deployment.md
    cloudflare-email.md
    custom-email-adapter.md
    local-development.md
    configuration.md
    api.md
    security-model.md
    sessions-and-cookies.md
    rate-limiting.md
    turnstile.md
    migrations.md
    troubleshooting.md
    roadmap.md

  templates/
    hono-basic/
    worker-basic/
    react-vite-worker/

  scripts/
    benchmark-password-worker.ts
    check-package-names.ts
    verify-examples.ts
    verify-migrations.ts

  .changeset/
  .editorconfig
  .gitignore
  .npmrc
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  LICENSE
  README.md
  SECURITY.md
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
```

---

## 7. Package Responsibilities

### 7.1 `cf-auth`

Thin unscoped shim package.

Responsibilities:

- expose `bin.cf-auth`
- delegate to `@cf-auth/cli`
- keep install size small
- allow `npx cf-auth@latest init`

Do not duplicate CLI logic here.

### 7.2 `@cf-auth/core`

Pure auth logic and data contracts.

Responsibilities:

- config schema and normalization
- user creation rules
- email and username normalization
- password validation
- password hashing and verification
- hash envelope parsing
- `needsRehash`
- key derivation
- token generation and hashing
- session creation primitives
- rate-limit key generation
- repository interfaces only
- error model
- raw token generation and token-hash envelope creation before repository writes

Must not import Hono or browser-only APIs.

### 7.3 `@cf-auth/worker`

Cloudflare Worker HTTP runtime.

Responsibilities:

- route handlers
- request parsing
- response helpers
- auth response headers
- cookie setting/clearing
- same-origin CORS defaults
- safe redirect handling
- D1 repository implementation
- D1 fallback rate limiter
- bindings interface
- terminal email adapter factory for development
- dev email route guard
- token confirmation HTML pages
- re-export `defineAuthConfig` and `byEnvironment` from core for generated config ergonomics

### 7.4 `@cf-auth/hono`

Hono adapter.

Responsibilities:

- `createAuthRoutes(authConfig)` with relative routes only
- `requireUser()` middleware
- `requireVerifiedUser()` middleware
- `optionalUser()` middleware
- `getAuthUser(c)` helper
- typed Hono bindings

### 7.5 `@cf-auth/client`

Browser SDK.

Responsibilities:

- same-origin auth client
- typed methods for auth endpoints
- `fetch` wrapper with `credentials: "include"`
- friendly typed errors
- no Node-only imports

### 7.6 `@cf-auth/cli`

Developer experience engine.

Responsibilities:

- scaffold new projects
- patch existing projects conservatively
- create/detect D1 bindings
- wrap Wrangler commands
- manage migrations
- generate secrets
- run diagnostics
- deploy
- generate safe snippets/types
- provide diagnostics and migration guidance

### 7.7 `create-cloudflare-auth`

`npm create` entry package.

Responsibilities:

- support `npm create cloudflare-auth@latest my-app`
- call into `@cf-auth/cli`
- keep quickstart stable

### 7.8 `@cf-auth/email-cloudflare`

Production Cloudflare Email adapter.

Responsibilities:

- send magic links
- send verification emails
- send password reset emails
- render HTML and plaintext templates
- support custom subject/body template overrides
- expose clear errors when binding is missing

### 7.9 `@cf-auth/testing`

Testing utilities.

Responsibilities:

- apply migrations to local D1 in tests
- create mock email adapters
- create test users/sessions
- provide Worker-compatible auth test environment

---

### 7.10 Package export contract

All packages must use explicit `package.json` export maps and type declarations.[^package-boundary]

Rules:

- publish ESM-first packages with `types` for every public entrypoint;
- document whether CJS is supported; if CJS is not supported, fail clearly rather than relying on implicit transpilation;
- keep `@cf-auth/client` browser-safe and free of `node:*`, Worker-only, and CLI-only imports;
- keep `@cf-auth/core` free of Hono imports and browser-only side effects;
- pin and document minimum supported versions for Node.js, pnpm, Wrangler, TypeScript, and Hono;
- run package boundary tests that import every public entrypoint in the intended runtime.

### 7.11 Version floor and runtime matrix

Before public beta, lock and document the supported toolchain matrix.[^version-floor]

Initial v1 floor:

| Tool or runtime | Minimum support target |
|---|---|
| Node.js for CLI/build tooling | `>=22.13.0`; generated `package.json` files must use the same engine floor. |
| pnpm | pnpm `11.x`; Stage 1 must pin the exact patch version in root `packageManager`, and generated projects must use the same major version. |
| Wrangler | Wrangler v4 `>=4.36.0` for all generated projects and examples, including projects that do not enable the optional Workers Rate Limiting API binding. |
| TypeScript | `>=6.0 <7` until CI explicitly validates TypeScript 7 declarations, generated examples, and package boundary tests. |
| Hono | `>=4.12.18 <5` for the Hono adapter and examples. Do not use Hono JWT, cache, or static-file middleware in auth routes. |
| Workers compatibility date | Generated current date, never earlier than `2024-09-23` when `nodejs_compat` is required. |

Rules:

- Stage 1 must choose and pin exact patch versions for pnpm, TypeScript, Wrangler, Hono, tsup, Vitest, Zod, and Changesets in `package.json` and CI;
- publish `engines`, peer dependency ranges, and package-manager metadata consistently;
- run CI against the documented floor and the latest supported versions;
- fail package publication if generated examples require versions outside the documented matrix;
- update docs and `doctor` whenever a platform minimum changes.

---

## 8. Tech Stack

| Area | Decision | Notes |
|---|---|---|
| Language | TypeScript | One language across runtime, SDK, CLI, snippets. |
| Runtime | Cloudflare Workers | Core product constraint. |
| Router | Hono default, plain Worker supported | Hono is default; core runtime must not require Hono. |
| Database | Cloudflare D1 | Native Cloudflare SQL storage. |
| Migrations | SQL files through Wrangler | Explicit migration lifecycle. |
| Query layer | Internal repository layer | No ORM in v1. |
| Email | Cloudflare Email adapter + custom adapter | Cloudflare-native default, but not local-dev dependency. |
| Password hashing | `node:crypto` `scrypt` | Requires `nodejs_compat`; benchmark. |
| Token hashing | HMAC-SHA-256 with derived subkeys | Store HMAC output only. |
| Validation | Zod | Runtime validation and inferred types. |
| Testing | Vitest + Workers Vitest pool | Run runtime tests inside Workers. |
| Build | tsup | Emit ESM and types with a single bundler across packages.[^build-tool] |
| Monorepo | pnpm workspaces | Good OSS workflow. |
| Releases | Changesets | Multi-package semver. |
| License | Apache-2.0 | Good default for infra/security OSS. |

### 8.1 Why no ORM in v1?

The schema is small and security-sensitive. An ORM adds hidden query behavior and migration surface area. Use explicit SQL and typed repository functions first.

### 8.2 Why no JWT by default?

JWTs make revocation and rotation harder for small apps. D1-backed opaque sessions are simpler to revoke, easier to reason about, and better aligned with MVP needs.

---

## 9. Bindings, Secrets, and Environment

### 9.1 Worker bindings

Recommended generated interface:

```ts
export interface CfAuthEnv {
  AUTH_DB: D1Database;
  AUTH_SECRET: string;
  AUTH_SECRET_PREVIOUS?: string;
  AUTH_EMAIL?: SendEmailBinding;
  AUTH_RATE_LIMITER?: RateLimitBinding;
  AUTH_ENV?: "development" | "preview" | "production";
  AUTH_PUBLIC_ORIGIN?: string;
  TURNSTILE_SECRET_KEY?: string;
}
```

`SendEmailBinding` is the adapter-facing interface in Section 24.4. `RateLimitBinding` is the Workers Rate Limiting API binding shape used only by the optional edge prefilter; D1 remains the authoritative limiter.

### 9.2 Required and optional secrets

| Secret | Required | Purpose |
|---|---:|---|
| `AUTH_SECRET` | yes | Current key-ring root secret for HMACs and internal signing. |
| `AUTH_SECRET_PREVIOUS` | optional | Previous key-ring root secrets for staged rotation. |
| `TURNSTILE_SECRET_KEY` | only if Turnstile enabled | Server-side Turnstile validation. |

Rules:

- `AUTH_SECRET` and `AUTH_SECRET_PREVIOUS` must be Worker secrets in remote preview and production environments.
- `AUTH_SECRET_PREVIOUS` must follow the same format rules as `AUTH_SECRET`, with comma-separated entries when more than one previous secret is retained.
- `.dev.vars` may hold local development secrets only and must not be committed.

### 9.3 `AUTH_SECRET` format

Use this exact format:

```text
<kid>.<base64url-encoded-32-random-bytes>
```

Example:

```text
k1.4Jp7zJhzxP7oA8Lbx_oM9j3MPf0GWRjWepKpaRtXx74
```

Rules:

- `kid` must match `/^[a-zA-Z0-9_-]{1,32}$/`.
- generated secret material must be exactly 32 random bytes encoded as unpadded base64url; parsers may accept longer unpadded base64url values that decode to at least 32 bytes.
- secret material must decode to at least 32 bytes.
- key-ring parsing must reject duplicate `kid` values across `AUTH_SECRET` and `AUTH_SECRET_PREVIOUS`.[^key-ring-kids]
- new writes use `AUTH_SECRET` only.
- verification accepts `AUTH_SECRET` and all comma-separated entries in `AUTH_SECRET_PREVIOUS`.
- raw root secret values are never logged.

`AUTH_SECRET_PREVIOUS` example:

```text
k0.m1h4Yd4p4A5o0i8EJwG3Q2sJbWQnFfRrA-8Q7f6TzJE,k-1.Lb3...
```

### 9.4 Key derivation

Derive purpose-specific subkeys from the root secret using HKDF-SHA-256.

HKDF inputs:

```text
ikm  = decoded root secret bytes
salt = "cf-auth:v1"
info = purpose string below
len  = 32 bytes
```

Purpose strings:

| Purpose | `info` string |
|---|---|
| Session token HMAC | `session-token-hmac` |
| Email token HMAC | `email-token-hmac` |
| Rate-limit key HMAC | `rate-limit-key-hmac` |
| IP hash | `event-ip-hash` |
| User-agent hash | `event-user-agent-hash` |
| Internal state signing | `internal-state-signing` |

Do not use raw `AUTH_SECRET` directly for all HMACs.

### 9.5 Environment mode

Use explicit environment mode. Do not infer production from `NODE_ENV`, request host, or a presumed Wrangler environment name.

Static config accepts either a concrete value or a runtime marker:

```ts
type AuthEnvMode = "development" | "preview" | "production";
type AuthEnvModeConfig = AuthEnvMode | "from-env";
type AuthPublicOriginConfig = string | "from-env";
```

Request-time mode resolution order:

1. concrete `runtime.mode` from config;
2. `env.AUTH_ENV` when `runtime.mode` is `"from-env"` or unset;
3. `@cf-auth/testing` test harness override, only in tests.

Request-time public-origin resolution order:

1. concrete `runtime.publicOrigin` from config when it is an absolute origin;
2. `env.AUTH_PUBLIC_ORIGIN` when `runtime.publicOrigin` is `"from-env"` or unset;
3. in `development` only, the validated request origin when the host is a trusted localhost host and no email adapter other than terminal/dev outbox is active.

The resolved runtime mode must be one of `development`, `preview`, or `production`. There is no implicit runtime fallback to the Wrangler environment name. Generated Wrangler configs must set `AUTH_ENV` and `AUTH_PUBLIC_ORIGIN` in top-level local config and in every named environment that uses auth. If mode or required public origin cannot be resolved, auth requests return a safe `config_error`, and `doctor` fails for the selected environment.

Rules:

- Dev email outbox works only in `development`.
- Production and preview email-link generation require an explicit `publicOrigin`.
- Production requires secure cookies.
- Preview may use configured preview origins, never arbitrary origins.
- `publicOrigin` must be an origin only: scheme, host, and optional port; no path, query, fragment, credentials, wildcard, or trailing slash.
- Development fallback from the request origin is allowed only for trusted localhost terminal-email flows and must produce a `doctor` warning so generated projects still prefer explicit `AUTH_PUBLIC_ORIGIN`.

### 9.6 Compatibility flags

Generated `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "compatibility_date": "2026-05-15",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

At generation time, use the current date. Generated Worker configs must also reference the Wrangler schema and enable observability so deployed apps have baseline logs and traces. Do not hard-code May 13, 2026 after this plan date.

---

## 10. Configuration Model

Generated `auth.config.ts`:

```ts
import { defineAuthConfig, byEnvironment, terminalEmail } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",

  runtime: {
    mode: "from-env",
    publicOrigin: "from-env",
    trustedHosts: ["localhost:8787", "127.0.0.1:8787", "example.com"],
  },

  database: {
    binding: "AUTH_DB",
  },

  session: {
    cookieName: "auto",
    maxAgeDays: 30,
    sameSite: "lax",
    secure: "auto",
    domain: undefined,
    requireVerifiedEmail: false,
  },

  request: {
    maxBodyBytes: 16 * 1024,
    requireOriginOnUnsafeMethods: true,
  },

  security: {
    allowedRequestOrigins: [],
    allowedPreviewRequestOrigins: [],
  },

  passwordHashing: {
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
  },

  signup: {
    enabled: true,
    requireEmailVerificationBeforeSession: false,
    enumerationSafe: false,
    username: {
      enabled: true,
      required: false,
      minLength: 3,
      maxLength: 32,
    },
  },

  login: {
    emailPassword: true,
    usernamePassword: true,
    magicLink: true,
    requireVerifiedEmail: false,
  },

  magicLink: {
    allowSignups: false,
    expiresInMinutes: 15,
    consumeMethod: "confirmation-post",
    activeTokenPolicy: "invalidate-previous",
  },

  passwordReset: {
    enabled: true,
    expiresInMinutes: 30,
    resetPage: { mode: "built-in" },
    revokeExistingSessions: true,
    createSessionAfterReset: false,
    markEmailVerifiedOnReset: true,
    activeTokenPolicy: "invalidate-previous",
  },

  emailVerification: {
    enabled: true,
    expiresInHours: 24,
    consumeMethod: "confirmation-post",
    createSessionAfterVerification: false,
    activeTokenPolicy: "invalidate-previous",
  },

  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" },
    }),
    production: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" },
    }),
  }),

  redirects: {
    defaultAfterLogin: "/dashboard",
    defaultAfterLogout: "/",
    defaultAfterEmailVerification: "/dashboard",
    defaultAfterPasswordReset: "/login",
    allowedOrigins: ["https://example.com"],
    allowedPreviewOrigins: [],
  },

  rateLimit: {
    adapter: "d1",
    edgePrefilter: "optional",
  },
});
```

### 10.1 Configuration rules

- Keep generated config small.
- Defaults must work locally.
- Secrets must never be stored in config.
- Production-only missing values must be reported by `cf-auth doctor`.
- Advanced features must be absent from default config unless enabled.
- Cross-subdomain cookie mode must be explicit and never default.
- Cross-site credentialed auth is not supported in v1.
- `defineAuthConfig` validates static config shape at module load.
- Runtime config resolution happens per request because bindings, secrets, mode, and execution context are request/runtime values.[^runtime-config]
- `publicOrigin` must be explicit in preview and production whenever email links can be generated.
- `trustedHosts` is used for request host validation and local/preview convenience. It is not the source of production email links.[^host-validation]
- `security.allowedRequestOrigins` controls browser mutation origins for production and development CORS/CSRF. Same-origin requests are allowed automatically after host validation; cross-origin same-site requests must be listed explicitly. Entries must be exact origins with no path, query, fragment, credentials, or wildcard.
- `security.allowedPreviewRequestOrigins` controls browser mutation origins in preview mode. Preview origins are not accepted in production unless the same exact origin is also present in `security.allowedRequestOrigins`.
- `redirects.allowedOrigins` controls where the app may redirect users after auth in production and development.
- `redirects.allowedPreviewOrigins` controls post-auth redirects in preview mode. Preview redirect origins are not accepted in production unless the same exact origin is also present in `redirects.allowedOrigins`.
- Do not reuse redirect allowlists as request-origin allowlists.[^origin-vs-redirect]
- `magicLink.activeTokenPolicy`, `emailVerification.activeTokenPolicy`, and `passwordReset.activeTokenPolicy` must be either `"invalidate-previous"` or `"allow-multiple-active"`; generated config uses `"invalidate-previous"`.
- `passwordReset.enabled = false` disables all password-reset routes and prevents password-reset tokens from being created.
- `magicLink.allowSignups = true` requires `signup.enabled = true` because just-in-time magic-link account creation is still a signup path.
- `magicLink.allowSignups = true` requires `signup.username.required = false` because the magic-link request body does not collect a username and JIT-created users are passwordless by design.
- `signup.enumerationSafe = true` requires `emailVerification.enabled = true`, `signup.requireEmailVerificationBeforeSession = true`, and `signup.username.required = false`; enumeration-safe signup must not create a session in the signup response.[^enumeration-safe-signup]
- `signup.requireEmailVerificationBeforeSession`, `login.requireVerifiedEmail`, and `session.requireVerifiedEmail` require `emailVerification.enabled = true`; no separate verification source exists in v1.
- If all password-login methods are disabled, `POST /auth/login` must be disabled rather than accepting requests that can never succeed.

### 10.2 Static config versus runtime config

`defineAuthConfig()` must not read Worker bindings, secrets, email bindings, D1 bindings, or execution context. It only validates static shape, defaultable options, route paths, and mutually exclusive options.

At request time, the Worker runtime must call an internal resolver equivalent to:

```ts
resolveAuthRuntimeConfig({
  config,
  request,
  env,
  ctx,
});
```

The resolved runtime config includes:

- mode;
- public origin;
- validated request host and canonical request origin;
- D1 binding instance;
- root secret key ring;
- email binding instance;
- Turnstile secret, if configured;
- cookie flags for the current origin;
- per-request logger/redactor;
- request ID;
- canonical client IP and user-agent hashes.

Static validation failures must throw during app startup. Runtime resolution failures must return safe `config_error` responses. When the D1 binding and redacted logger have already been resolved, runtime resolution failures must also write redacted auth events; otherwise they must emit only redacted logs.

### 10.3 `basePath` rule

`basePath` is the public path where auth routes are mounted.

For Hono:

```ts
app.route(authConfig.basePath, createAuthRoutes(authConfig));
```

`basePath` validation rules:

- must begin with exactly one `/`;
- must not end with `/` unless it is exactly `/`;
- must not contain a query string, fragment, wildcard, URL, control character, encoded slash, encoded backslash, or repeated slash segment;
- generated config uses `/auth`; v1 examples must not use `/` because auth routes should not own the entire app root.

`createAuthRoutes(authConfig)` must define relative routes only:

```text
/signup
/login
/logout
/user
/magic-link/request
/magic-link/verify
/magic-link/consume
/email/verify/request
/email/verify
/email/verify/consume
/password/reset/request
/password/reset
/password/reset/confirm
```

Do not define routes internally as `/auth/...` inside the Hono router. That causes `/auth/auth/...` bugs.

For plain Worker:

- `createAuthHandler(authConfig)` uses `basePath` to match and strip the prefix.
- Path matching must be boundary-aware: `/auth` and `/auth/*` match, but `/authentication`, `/authentic`, and `/authz` do not.[^route-boundary]

### 10.4 Email verification policy semantics

Email verification settings have separate meanings:

- `emailVerification.enabled` controls whether verification tokens and emails are available.
- `signup.requireEmailVerificationBeforeSession` controls whether signup may create an initial session before verification.
- `login.requireVerifiedEmail` controls whether password login requires `email_verified_at`.
- `session.requireVerifiedEmail` controls whether session lookup itself rejects unverified users.
- `requireVerifiedUser()` is the recommended route-level helper when only some routes require verified email.[^verified-user]

Do not treat `emailVerification.enabled` alone as “block all sessions until verified.” That behavior must be explicit.

Static config validation must reject combinations that require verified email while disabling all verification routes. `requireVerifiedUser()` may still be used with imported or manually maintained users, but the generated config must not create a default path where ordinary users can be required to verify without any verification endpoint available.

---

## 11. Wrangler Configuration

Generated `wrangler.jsonc` for a local-first app with a named production environment:[^wrangler-environments]

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-app-dev",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-15",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },

  "vars": {
    "AUTH_ENV": "development",
    "AUTH_PUBLIC_ORIGIN": "http://localhost:8787"
  },

  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "my-app-auth-dev",
      "database_id": "REPLACE_WITH_DATABASE_ID"
    }
  ],

  "env": {
    "production": {
      "name": "my-app",
      "vars": {
        "AUTH_ENV": "production",
        "AUTH_PUBLIC_ORIGIN": "https://example.com"
      },
      "d1_databases": [
        {
          "binding": "AUTH_DB",
          "database_name": "my-app-auth",
          "database_id": "REPLACE_WITH_DATABASE_ID"
        }
      ],
      "send_email": [
        {
          "name": "AUTH_EMAIL",
          "allowed_sender_addresses": ["auth@example.com"]
        }
      ]
    }
  }
}
```

Generated `.dev.vars.example`:

```text
AUTH_ENV=development
AUTH_PUBLIC_ORIGIN=http://localhost:8787
AUTH_SECRET=k_dev.REPLACE_WITH_GENERATED_BASE64URL_SECRET
```

Rules:

- `AUTH_SECRET` goes in `.dev.vars` locally and as a Worker secret remotely.
- `AUTH_SECRET_PREVIOUS`, when used, also goes in `.dev.vars` locally and as a Worker secret remotely.
- Do not commit real `.dev.vars`.
- `AUTH_PUBLIC_ORIGIN` may be a var; `AUTH_SECRET` and `AUTH_SECRET_PREVIOUS` must be secrets in preview and production.
- Generated runnable projects must not leave `REPLACE_WITH_DATABASE_ID` in the selected local or production environment. If automatic D1 creation is declined, `init` must either write a documented local-only placeholder accepted by Wrangler for local development or stop with the exact `wrangler d1 create` command the user must run.
- Cloudflare Email binding must not be required for local development.
- Wrangler bindings and `vars` are non-inheritable across named environments; repeat D1, email, rate-limit bindings, and vars in every named environment that uses them.
- Do not put `AUTH_ENV=production` in the top-level config used by local development.
- `cf-auth deploy --env production` must deploy the named production environment by default.
- `cf-auth deploy` without `--env` must fail unless `doctor` proves the top-level config is intentionally production-safe.
- `doctor` must detect missing named-environment bindings, top-level development vars used for remote deploys, database placeholders in deploy targets, and production secrets that exist only in local `.dev.vars`.

---

## 12. Database Design

Use D1 with explicit SQL migrations.

### 12.1 Timestamp convention

Use Unix milliseconds in application code and D1 `INTEGER` columns.

### 12.2 ID convention

Use random, prefixed, URL-safe IDs.

| Entity | Prefix | Entropy |
|---|---|---:|
| User | `usr_` | 128 bits |
| Session row | `ses_` | 128 bits |
| Verification token row | `vtok_` | 128 bits |
| Auth event | `evt_` | 128 bits |
| Token consume ID | `con_` | 128 bits |

Raw auth tokens need stronger entropy; see [Section 14](#14-token-design).

### 12.3 Migration `0001_initial.sql`

```sql
CREATE TABLE auth_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT INTO auth_meta (key, value, updated_at)
VALUES ('schema_version', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO auth_schema_migrations (version, name, applied_at)
VALUES ('0001', 'initial', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  username TEXT,
  normalized_username TEXT UNIQUE,
  password_hash TEXT,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  user_agent_hash TEXT,
  ip_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  normalized_email TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('magic_link', 'email_verification', 'password_reset')),
  redirect_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  consume_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  CHECK (redirect_to IS NULL OR length(redirect_to) <= 2048),
  CHECK (normalized_email IS NULL OR length(normalized_email) <= 320),
  CHECK ((used_at IS NULL AND consume_id IS NULL) OR (used_at IS NOT NULL AND consume_id IS NOT NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL),
  CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)),
  CHECK (
    (type IN ('email_verification', 'password_reset') AND user_id IS NOT NULL AND normalized_email IS NULL)
    OR (
      type = 'magic_link'
      AND (
        (user_id IS NOT NULL AND normalized_email IS NULL)
        OR (user_id IS NULL AND normalized_email IS NOT NULL)
      )
    )
  ),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE rate_limits (
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (action, key)
);
```

### 12.4 Migration `0002_indexes.sql`

```sql
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_active_lookup_idx ON sessions(token_hash, expires_at, revoked_at);

CREATE INDEX verification_tokens_email_type_idx
  ON verification_tokens(normalized_email, type);

CREATE INDEX verification_tokens_user_type_idx
  ON verification_tokens(user_id, type);

CREATE INDEX verification_tokens_expires_at_idx
  ON verification_tokens(expires_at);

CREATE INDEX verification_tokens_active_user_type_idx
  ON verification_tokens(user_id, type, used_at, revoked_at, expires_at);

CREATE INDEX verification_tokens_active_email_type_idx
  ON verification_tokens(normalized_email, type, used_at, revoked_at, expires_at);

CREATE INDEX auth_events_user_id_idx ON auth_events(user_id);
CREATE INDEX auth_events_created_at_idx ON auth_events(created_at);
CREATE INDEX auth_events_type_created_at_idx ON auth_events(event_type, created_at);

CREATE INDEX rate_limits_reset_at_idx ON rate_limits(reset_at);

INSERT INTO auth_schema_migrations (version, name, applied_at)
VALUES ('0002', 'indexes', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

UPDATE auth_meta
SET value = '2', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE key = 'schema_version';
```

### 12.5 Schema rules

- Store normalized email separately from display email.
- Store normalized username separately from display username.
- `password_hash` may be `NULL` for magic-link-only users.
- Never store raw session tokens.
- Never store raw magic-link, verification, or reset tokens.
- Token rows are single-use.
- Email-verification and password-reset tokens must be user-bound and must not also carry a normalized-email subject.
- Magic-link tokens must carry exactly one subject: either a user ID or, when `allowSignups` is enabled, a normalized email for just-in-time user creation.[^token-subject-invariant]
- `used_at` and `consume_id` mark token consumption and must be set together.
- `revoked_at` and `revoked_reason` mark explicit invalidation without pretending a token was used and must be set together.
- A token row must not be both consumed and revoked.
- Token verification must reject expired, used, revoked, wrong-type, and disabled-user tokens.
- Migrations are append-only and versioned.
- Do not wrap D1 migration files in explicit `BEGIN`/`COMMIT` statements.
- Future migrations that rewrite tables with foreign keys must use `PRAGMA defer_foreign_keys = on` for the migration transaction when needed.[^d1-migration-fks]
- Every migration must insert into `auth_schema_migrations` and update `auth_meta.schema_version`.
- `doctor` must compare local migration files with `auth_schema_migrations` and `auth_meta`.
- Metadata JSON columns must enforce valid JSON where supported by the test matrix.[^json-valid]

### 12.6 Why composite primary key for `rate_limits`?

The same email or IP can be used for multiple actions. A single-column primary key on `key` would cause login, signup, reset, and verification counters to collide. Use `PRIMARY KEY (action, key)`.

---

## 13. Repository Layer

Implement typed D1 repository functions. Repository interfaces and row/input/output types live in `@cf-auth/core`; D1 implementations live in `@cf-auth/worker`. Do not spread raw SQL through route handlers.

### 13.1 User repository

Required functions:

```ts
createUser(input): Promise<UserRow>;
findUserById(id): Promise<UserRow | null>;
findUserByNormalizedEmail(normalizedEmail): Promise<UserRow | null>;
findUserByNormalizedUsername(normalizedUsername): Promise<UserRow | null>;
updatePasswordHash(userId, passwordHash, now): Promise<void>;
markEmailVerified(userId, verifiedAt): Promise<void>;
setUserDisabled(userId, disabledAt): Promise<void>;
updateUserMetadata(userId, metadata): Promise<void>;
```

### 13.2 Session repository

Required functions:

```ts
createSession(input): Promise<SessionRow>;
findSessionByTokenHash(tokenHash, now): Promise<SessionWithUserRow | null>;
touchSession(sessionId, now): Promise<void>;
revokeSession(sessionId, now): Promise<void>;
revokeSessionByTokenHash(tokenHash, now): Promise<void>;
revokeAllUserSessions(userId, now): Promise<void>;
deleteExpiredSessions(now): Promise<number>;
```

Rules:

- `createSession` receives a precomputed `token_hash`; it must never receive, return, log, or generate the raw session token.
- `touchSession` must be lazy. Do not update more than once per 10 minutes per session.
- `findSessionByTokenHash` must reject expired, revoked, and disabled-user sessions.

### 13.3 Verification token repository

Required functions:

```ts
createVerificationToken(input): Promise<VerificationTokenRow>;
revokeActiveVerificationTokens(input): Promise<number>;
consumeVerificationToken(input): Promise<VerificationTokenRow | null>;
consumeMagicLinkAndCreateSession(input): Promise<{ user: UserRow; session: SessionRow; redirectTo: string } | null>;
consumeEmailVerification(input): Promise<{ user: UserRow; session?: SessionRow; redirectTo: string } | null>;
consumePasswordReset(input): Promise<{ user: UserRow; session?: SessionRow; redirectTo: string } | null>;
incrementTokenAttempts(tokenId): Promise<void>;
deleteExpiredVerificationTokens(now): Promise<number>;
```

Repository functions never generate raw tokens, raw session cookies, password hashes, or token-hash envelopes. `createVerificationToken` receives a precomputed `token_hash`; flow-specific consume functions receive any precomputed session rows, session token hashes, and password hashes needed for their batch. `createVerificationToken` must reject subject shapes that are invalid for the token type. A token row must never contain both `user_id` and `normalized_email`; magic-link JIT-signup tokens start with a normalized-email subject and switch to a user subject only inside the successful consume transaction. `consumeVerificationToken` is useful for tests and simple flows. Route handlers must use flow-specific consume functions so token consumption and state mutation happen in one `db.batch()` transaction. Token request flows must revoke previous active tokens of the same type for the same subject namespace when the active-token policy is `invalidate-previous`; revocation writes both `revoked_at` and a non-null `revoked_reason`.[^active-token-policy][^repo-token-boundary]

### 13.4 Event repository

Required functions:

```ts
writeAuthEvent(input): Promise<void>;
listRecentAuthEvents(userId, limit): Promise<AuthEventRow[]>;
```

Rules:

- Write events for successful login, failed login, logout, token request, token consume, reset success, reset failure, email send failure, rate limit hit, and config/runtime failures.
- Do not log raw tokens, raw passwords, raw secrets, raw IPs, or raw user agents.

### 13.5 Rate limit repository

Required functions:

```ts
hitFixedWindow(input: {
  key: string;
  action: string;
  windowMs: number;
  limit: number;
  now: number;
}): Promise<{ allowed: boolean; count: number; resetAt: number }>;

deleteExpiredRateLimitRows(now): Promise<number>;
```

The `key` passed to the repository must already be HMACed. Do not pass raw email or IP.

Required SQL pattern:

```sql
INSERT INTO rate_limits (action, key, count, reset_at, updated_at)
VALUES (?, ?, 1, ?, ?)
ON CONFLICT(action, key) DO UPDATE SET
  count = CASE
    WHEN rate_limits.reset_at <= excluded.updated_at THEN 1
    ELSE rate_limits.count + 1
  END,
  reset_at = CASE
    WHEN rate_limits.reset_at <= excluded.updated_at THEN excluded.reset_at
    ELSE rate_limits.reset_at
  END,
  updated_at = excluded.updated_at;
```

Then select the row in the same `db.batch()` call:

```sql
SELECT count, reset_at
FROM rate_limits
WHERE action = ? AND key = ?;
```

Rules:

- compute `allowed` as `count <= limit` after the select;
- require exactly one selected row;
- treat an upsert or select failure as a safe `rate_limit_error` server failure, not as an allow decision;
- never use `RETURNING` in the required implementation path so local and remote D1 behavior stays identical across the test matrix.

---

## 14. Token Design

### 14.1 Raw token format

Use opaque, dot-delimited tokens with key IDs.[^token-format]

```text
cfauth.<purpose>.<kid>.<base64url-random-32-bytes>
```

Purposes:

| Purpose | Raw token purpose segment | Example prefix |
|---|---|---|
| Session cookie | `ses` | `cfauth.ses.k1.` |
| Magic link | `magic` | `cfauth.magic.k1.` |
| Email verification | `verify` | `cfauth.verify.k1.` |
| Password reset | `reset` | `cfauth.reset.k1.` |

Example:

```text
cfauth.magic.k1.N8TfG0HiLLqotEOhF8K6JfzzpGWOhQbQKOQ4d70LWhQ
```

Rules:

- random component must be exactly 32 random bytes before unpadded base64url encoding in v1;
- raw token parser must use this strict regex and reject all other shapes: `^cfauth\.(ses|magic|verify|reset)\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{43})$`;
- `kid` must match `/^[a-zA-Z0-9_-]{1,32}$/` and must not contain `.`;
- random segment must be unpadded base64url and must not contain `.`;
- raw tokens must never be logged;
- raw tokens must never be stored in D1;
- raw tokens may appear only in email links, token landing URLs/browser history, hidden fields on built-in token pages, JSON or form bodies submitted to token consume/confirm endpoints, and HTTP-only cookies.

### 14.2 Stored token hash envelope

Store:

```text
hmac-sha256$v=1$kid=<kid>$purpose=<purpose>$hash=<base64url>
```

Hash input:

```text
raw token string exactly as issued
```

Envelope parser rules:

- field order is fixed as `algorithm`, `v`, `kid`, `purpose`, `hash`;
- unknown fields, missing fields, duplicate fields, empty values, and unsupported versions are rejected;
- `hash` must be unpadded base64url-encoded 32-byte HMAC output.

HMAC key:

- derived key for `session-token-hmac` when purpose is session;
- derived key for `email-token-hmac` for magic/verify/reset.

Envelope purpose values:

| Raw purpose segment | Envelope purpose |
|---|---|
| `ses` | `session` |
| `magic` | `magic_link` |
| `verify` | `email_verification` |
| `reset` | `password_reset` |

### 14.3 Token lookup

For an incoming raw token:

1. Parse purpose, `kid`, and random segment with the strict token regex.
2. Reject malformed tokens before any D1 lookup.
3. Find matching root secret from the current or previous key ring; reject the key ring before lookup if `kid` values are duplicated.
4. Derive purpose subkey.
5. Compute stored hash envelope.
6. Look up D1 row by exact `token_hash`.
7. Reject if no matching key, malformed token, expired row, wrong type, used row, revoked row, or disabled user.

### 14.4 Active-token policy

Default policy for magic-link, email-verification, and password-reset tokens is `invalidate-previous`.[^active-token-policy]

Valid policy values:

```ts
type ActiveTokenPolicy = "invalidate-previous" | "allow-multiple-active";
```

When a new token is created for the same user or normalized email and token type:

1. mark previous active tokens with `revoked_at = now` and `revoked_reason = 'superseded'`;
2. create the new token;
3. store the validated redirect target on the new token row.

Rules:

- password reset must invalidate previous active password reset tokens;
- email verification must invalidate previous active verification tokens;
- magic link must invalidate previous active magic-link tokens unless config explicitly chooses `allow-multiple-active`;
- token consumption must reject revoked tokens;
- cleanup may delete revoked/expired tokens after the configured retention window.

### 14.5 Secret rotation behavior

MVP supports staged verification with previous secrets.

- New tokens use `AUTH_SECRET`.
- Existing tokens can validate against `AUTH_SECRET_PREVIOUS` until they expire or sessions are revoked.
- The current `kid` must not appear in `AUTH_SECRET_PREVIOUS`; staged rotation depends on unambiguous key IDs.[^key-ring-kids]
- `rotate-secret --apply` must warn that remote secrets cannot always be read back. If the old value is unknown, rotation invalidates existing tokens.
- Future versions may add a richer key-management CLI.

---

## 15. Password Hashing

### 15.1 Hash envelope

Use `node:crypto` `scrypt` and store:

```text
scrypt$v=1$n=<N>$r=<r>$p=<p>$keylen=<bytes>$maxmem=<bytes>$salt=<base64url>$hash=<base64url>
```

Default Workers-balanced profile:

```ts
{
  algorithm: "scrypt",
  N: 32768,
  r: 8,
  p: 1,
  keyLen: 64,
  maxmem: 64 * 1024 * 1024
}
```

Development-fast profile, only for tests/examples when explicitly enabled:

```ts
{
  algorithm: "scrypt",
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 64,
  maxmem: 32 * 1024 * 1024
}
```

Non-default high-cost profile:

```ts
{
  algorithm: "scrypt",
  N: 65536,
  r: 8,
  p: 1,
  keyLen: 64,
  maxmem: 96 * 1024 * 1024
}
```

Rules:

- Production default is Workers-balanced.[^password-worker-profile]
- `N` must be a power of two, `r`, `p`, `keyLen`, and `maxmem` must be positive integers, and `salt` must decode to at least 16 bytes.
- New hashes use 16 random salt bytes unless config explicitly sets a larger salt length.
- Verification uses the parameters in the envelope and a `maxmem` value at least as large as the envelope value, subject to a documented hard cap that rejects unexpectedly expensive legacy envelopes instead of attempting unbounded work.
- The high-cost profile is not a default Worker recommendation; it is allowed only when project benchmarks pass on the target Worker plan and traffic pattern.
- `doctor` must run a password benchmark and warn when p95 hash time exceeds `750 ms`, when the configured semaphore queue would time out under a two-request burst, when Worker CPU/memory budget is unsuitable, or when params are below configured policy. The benchmark must use three warm-up hashes and ten measured hashes in the Workers local runtime. Remote production benchmarks are opt-in; when unavailable, `doctor --env production` must label local benchmark results as local estimates, not production guarantees.
- Document that OWASP’s scrypt recommendation is stricter than the Workers-balanced profile. Workers deployments must balance hash cost against isolate memory, CPU budget, and concurrency.
- Do not silently lower password parameters.
- `needsRehash` must return true when stored params are weaker than current config.
- Do not implement password peppering in v1; password envelopes must remain verifiable from the stored hash envelope alone.[^pepper]

### 15.2 Password validation

Default rules:

- min length: 8 Unicode code points
- max length: 128 Unicode code points
- reject encoded UTF-8 passwords larger than 512 bytes before hashing
- reject all-whitespace passwords
- do not trim, lowercase, normalize, or otherwise transform the password before hashing
- no composition rules by default
- provide a synchronous or asynchronous config hook that receives the raw password string and returns `{ ok: true }` or `{ ok: false, code: string, message: string }`

### 15.3 Password verification

Rules:

- Use the parameters from the stored hash envelope.
- Compare derived hash bytes with a wrapper around `timingSafeEqual` or equivalent safe comparison that handles length mismatch without throwing.[^safe-compare]
- Cap password length before hashing to avoid DoS.
- Missing account and wrong password must both return `invalid_credentials`.
- Missing account must still run a dummy password verification path.
- Users with `password_hash = NULL` must also run a dummy verification path and return `invalid_credentials` for password login.

Dummy hash requirements:

- Include a precomputed dummy hash for the default profile.
- If config params differ, lazily generate and cache a dummy hash for that config.
- Never skip dummy verification for absent users.

### 15.4 Password hashing concurrency guard

Password hashing must use a per-isolate semaphore.[^hash-concurrency]

Default:

```ts
passwordHashing: {
  maxConcurrentHashesPerIsolate: 1,
  queueTimeoutMs: 2_000,
}
```

Rules:

- Hashing work for signup, password login, password reset confirm, dummy verification, and rehash must use the semaphore.
- If the queue timeout is reached, return `429` with `rate_limited` or `503` with `server_busy`; use `429` for abusive endpoints and `503` only for clearly non-abusive overload.
- Do not start password hashing for password reset confirm until the token is parsed, cheap password validation passes, rate limits pass, and the token row is known to be valid and active.[^reset-hash-order]
- Benchmarks must report p50/p95 hash time and effective throughput for the configured profile.

---

## 16. Normalization and Validation

### 16.1 Email normalization

MVP rule:

- trim leading and trailing whitespace before validation and storage;
- lowercase the full email for `normalized_email`;
- preserve the trimmed display email in `users.email` for explicit signup flows;
- for magic-link JIT signups where no user exists, set `users.email` to `normalized_email` because the token row stores only the normalized subject and the consume request contains only the opaque token;[^jit-email-display]
- reject missing `@`, multiple `@`, empty local part, empty domain, whitespace/control characters, malformed domain labels, and values longer than 320 characters;
- use Zod email validation plus explicit tests for the cases above, or an equivalent validator that passes the same tests.

Do not implement provider-specific behavior such as Gmail dot removal in v1.

### 16.2 Username normalization

Default rules:

- trim whitespace
- lowercase
- allowed characters: `a-z`, `0-9`, `_`, `-`
- min length: 3
- max length: 32
- reject usernames that look like emails
- reserve common system names:
  - `admin`
  - `root`
  - `support`
  - `auth`
  - `api`
  - `login`
  - `logout`
  - `signup`
  - `me`
  - `settings`
  - `password`
  - `reset`
  - `verify`
  - `email`
  - `dev`
  - `emails`
  - `user`
  - `users`
  - `session`
  - `sessions`

### 16.3 IP and user-agent canonicalization

Before deriving rate-limit keys or auth event hashes:[^canonicalization]

- use Cloudflare request metadata when available;
- normalize IPv4 addresses to dotted decimal;
- normalize IPv6 addresses to a canonical lowercase compressed form;
- reject or bucket malformed IP fallback values;
- do not trust arbitrary forwarded headers unless explicitly configured;
- trim user-agent strings and cap them before hashing;
- store only HMAC-derived hashes, never raw values.

---

## 17. Cookie and Session Design

### 17.1 Cookie name resolution

When `session.cookieName = "auto"`, resolve as:

| Mode | Cookie name | Secure | Domain |
|---|---|---:|---|
| development over plain localhost HTTP | `cfauth-session` | false | none |
| production same-origin host-only | `__Host-cfauth-session` | true | none |
| production cross-subdomain | `__Secure-cfauth-session` | true | configured parent domain |
| preview HTTPS host-only | `__Host-cfauth-session` | true | none |

Rules:

- `__Host-` requires `Secure`, HTTPS, `Path=/`, and no `Domain`.
- `__Secure-` requires `Secure` and HTTPS.
- Cross-subdomain mode must be explicit.
- `doctor` must reject invalid prefix/flag/domain combinations.

### 17.2 Default cookie flags

- `HttpOnly`
- `Secure` in production/preview HTTPS
- `SameSite=Lax`
- `Path=/`
- no `Domain` unless cross-subdomain mode is explicitly configured

### 17.3 Session lifecycle

1. User logs in, signs up, or consumes a magic link.
2. Runtime generates random opaque session token.
3. Runtime stores only HMAC token hash in D1.
4. Runtime sends raw token as HTTP-only cookie.
5. Incoming requests read cookie and HMAC the token.
6. D1 lookup validates token hash, expiry, revocation, and user state.
7. Logout revokes the session row and clears cookie.
8. Expired sessions are ignored and later cleaned.

### 17.4 Cookie clearing

Cookie clearing must use the same name, path, domain, secure, and SameSite mode as the cookie being cleared.[^cookie-clear]

Rules:

- same-origin host-only cookies are cleared with no `Domain` attribute;
- cross-subdomain cookies are cleared with the configured parent domain;
- when migrating between host-only and parent-domain modes, clear both the old and new candidate cookie names;
- logout must clear the cookie even when no session row exists;
- cookie-clearing tests must cover development HTTP, production host-only HTTPS, and cross-subdomain HTTPS.

### 17.5 Rolling sessions

Not required for MVP.

MVP behavior:

- fixed 30-day session lifetime by default
- lazy `last_seen_at` update no more than once per 10 minutes per session

### 17.6 Auth-state read consistency

Session and token checks are security decisions.[^primary-auth-reads]

Rules:

- session lookup, token lookup, disabled-user checks, and password-reset token checks must use the normal D1 primary path or `withSession("first-primary")`;
- do not use `withSession("first-unconstrained")` for auth-state decisions;
- read replicas may be used only for non-security analytics, reporting, and maintenance queries where stale reads are acceptable;
- tests must cover a revoked session and a consumed token immediately after write.

---

## 18. HTTP Security Defaults

All auth responses must include:

```text
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

CORS-enabled responses must also include `Vary: Origin` when the `Access-Control-Allow-Origin` value is derived from the request origin.[^cors-vary]

Auth routes must not be mounted behind broad cache middleware. Generated Hono examples must mount auth routes before cache middleware and must not apply Hono cache/static middleware to auth routes.

HTML token confirmation and built-in password-reset pages must also include:

```text
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
X-Frame-Options: DENY
```

Rules:

- Do not include third-party scripts or images on token or password-reset pages.
- Do not log full URLs containing token query params.
- After token POST consumption, redirect without token in URL.
- JSON endpoints require `Content-Type: application/json` unless explicitly documented; parameters such as `application/json; charset=utf-8` are valid.[^content-type]
- Token confirmation and built-in password-reset POST endpoints may accept `application/x-www-form-urlencoded` because they are submitted by built-in HTML forms.

### 18.1 Request body size limit

Default maximum request body size for auth routes is 16 KiB.[^body-limit]

Rules:

- enforce the limit before calling `request.json()` or `request.formData()`;
- reject oversized bodies with `413 Payload Too Large`;
- apply the limit to JSON and form endpoints;
- allow explicit configuration, but warn in `doctor` when the limit is above 64 KiB;
- tests must include oversized JSON, oversized form bodies, and missing `Content-Length` streaming cases where the runtime permits streaming.

---

## 19. CSRF and CORS Model

### 19.1 Default same-origin mode

Default auth routes are same-origin only.

Rules:

- Require JSON content type for JSON mutations.
- Do not accept normal HTML form submissions for JSON mutation endpoints.
- Disable CORS by default.
- Use `SameSite=Lax` cookies by default.
- Built-in token confirmation and password-reset forms are the only form POST exceptions.

### 19.2 Origin checks

For unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`):

- If `Origin` is present, it must match the validated request origin or an explicitly configured `security.allowedRequestOrigins` entry.
- Same-origin requests are allowed automatically after host validation; same-site cross-origin requests must be explicitly listed.
- In production and preview, host validation runs before the origin comparison.
- When `request.requireOriginOnUnsafeMethods` is `true`, missing `Origin` is rejected for unsafe auth-route requests in production and preview.[^origin-absence]
- Setting `request.requireOriginOnUnsafeMethods` to `false` is an explicit non-browser mode; `doctor` must emit a high-severity warning for production because browser cookie-authenticated mutations become harder to audit.
- `Sec-Fetch-Site` may be used as supporting evidence, but it must not replace explicit origin validation for browser cookie flows.
- Token confirmation and built-in password-reset forms are still unsafe methods and must pass the same origin checks.
- Reject unknown origins with `403`.

### 19.3 Cross-origin and cross-site modes

MVP supports same-origin auth by default and same-site cross-origin deployments only when explicitly configured.[^same-site]

Allowed in v1:

- same-origin auth routes with `SameSite=Lax` cookies;
- same-site cross-origin requests such as `app.example.com` to `api.example.com` when parent-domain cookie mode and explicit `security.allowedRequestOrigins` entries are configured;
- origin checks on every unsafe method.

Not supported in v1:

- credentialed cross-site CORS;
- `SameSite=None` session cookies;
- wildcard credentialed CORS;
- browser clients hosted on arbitrary third-party origins.

Config validation must reject `SameSite=None` unless a future version defines a complete CSRF implementation. A future implementation may add double-submit CSRF, same-origin proxy mode, or an explicit custom CSRF verifier hook, but those are not part of the v1 contract.

### 19.4 Middleware ordering

Docs must say auth routes are mounted before broad app-level CORS middleware. The auth route implementation must also override unsafe CORS behavior so auth routes remain safe when an application-level middleware is mounted earlier by mistake.

Rules:

- auth routes may emit CORS headers only for explicitly allowed request origins;
- wildcard CORS is forbidden for credentialed auth routes;
- when echoing a request origin, include `Vary: Origin`;[^cors-vary]
- redirects must use the redirect allowlist, not the CORS/request-origin allowlist.[^origin-vs-redirect]

### 19.5 CORS preflight behavior

When CORS is explicitly enabled by `security.allowedRequestOrigins` or `security.allowedPreviewRequestOrigins`, auth routes must handle `OPTIONS` preflight requests themselves.

Rules:

- preflight handling runs after host validation;
- if `Origin` is absent, return `204` without credentialed CORS headers;
- if `Origin` is present and not allowed for the resolved mode, return `403` without credentialed CORS headers;
- if `Origin` is allowed, return `204` with exact `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age: 600`, and `Vary: Origin`;
- `Access-Control-Allow-Methods` is limited to the auth-route methods: `GET`, `POST`, and `OPTIONS`;
- `Access-Control-Allow-Headers` is limited to `Content-Type` unless a future config key explicitly adds safe custom headers;
- safe-method JSON responses such as `GET /auth/user` may emit credentialed CORS headers only for explicitly allowed origins;
- auth routes must never emit `Access-Control-Allow-Origin: *`.

---

## 20. Redirect and URL Safety

### 20.1 `publicOrigin`

Preview and production email links must be generated from configured `publicOrigin`. Development terminal-email links should also use configured `publicOrigin` when available; the request-origin fallback is limited to trusted localhost development flows from Section 9.5.

Never build preview or production email links from:

- request `Host`
- `X-Forwarded-Host`
- arbitrary request URL
- unvalidated `redirectTo`

### 20.2 Allowed redirect targets

Allowed by default:

- same-origin relative paths beginning with a single `/`, with optional query string and fragment after the path;
- configured production redirect origins;
- configured preview redirect origins if enabled.

Redirect allowlist entries must be exact origins of the form `https://host[:port]`, except local development may use `http://localhost[:port]` and `http://127.0.0.1[:port]`. Entries with paths, queries, fragments, credentials, wildcards, or trailing slash differences must be rejected during static config validation. Runtime redirect targets may include path, query, and fragment only after they have been resolved against either the validated request origin for relative paths or an explicitly allowed absolute origin.

Rejected:

- `javascript:` URLs
- `data:` URLs
- protocol-relative URLs like `//evil.com`
- paths beginning with backslashes or encoded leading slash/backslash variants that could be interpreted as another origin
- URLs containing ASCII control characters, tabs, CRLF, or malformed percent-encoding
- malformed URLs
- unknown absolute origins
- redirects that change after token creation

Normalize redirect targets once, store the normalized value, and never re-interpret a stored redirect with a different parser at consume time.[^redirect-normalization]

### 20.3 Token redirect storage

When creating a magic-link or email-verification token:

1. Validate `redirectTo`.
2. Normalize it.
3. Store the normalized value in `verification_tokens.redirect_to`.
4. Email link must not include `redirectTo`.
5. Consume endpoint must use stored `redirect_to`, not a new query param.

When creating a password-reset token:

1. Validate `afterResetRedirectTo`.
2. Normalize it.
3. Store the normalized value in `verification_tokens.redirect_to`.
4. Email link must point to the configured reset page with only the raw token.
5. Confirm endpoint must use stored `redirect_to`, not a new query param.

---

## 21. API Contract

All JSON endpoints require `Content-Type: application/json` unless explicitly documented. `application/json` with parameters, such as `application/json; charset=utf-8`, is accepted.

### 21.0 Endpoint enablement rules

Feature-disabled endpoints return `404` with error code `not_found` and perform no side effects. This applies to disabled signup, disabled magic-link login, disabled email verification routes, disabled password reset routes, and `POST /auth/login` when both password-login methods are disabled.

For `POST /auth/login`, identifier handling is method-aware:

- email-shaped identifiers require `login.emailPassword = true`;
- non-email identifiers require `login.usernamePassword = true`;
- when the relevant method is disabled, return the normal `invalid_credentials` response instead of revealing whether the identifier exists;
- if both password-login methods are disabled, the route itself is disabled and returns `404`.

### 21.1 Success user shape

```json
{
  "id": "usr_...",
  "email": "person@example.com",
  "username": "person",
  "emailVerified": true,
  "createdAt": 1760000000000
}
```

Do not return password hashes, token hashes, raw tokens, IP hashes, user-agent hashes, or metadata by default.

### 21.2 Error shape

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid credentials"
  }
}
```

Optional diagnostic field in non-production only:

```json
{
  "error": {
    "code": "config_error",
    "message": "Auth email binding is missing",
    "debug": "Expected env.AUTH_EMAIL"
  }
}
```

When available, include a redaction-safe `requestId` at the top level of error responses and auth events so production failures can be correlated without exposing secrets or tokens.[^response-request-id]

### 21.3 HTTP status rules

| Status | Use |
|---:|---|
| 200 | Successful JSON operation. |
| 303 | Successful POST browser redirect flow. |
| 400 | Invalid JSON, validation failure, unsafe redirect, malformed token. |
| 401 | Missing/invalid session or invalid credentials. |
| 403 | Disabled account, email verification required, invalid origin. |
| 404 | Dev-only routes outside dev mode and feature-disabled auth endpoints; avoid for identity existence checks. |
| 409 | Signup duplicate email/username when enumeration-safe signup is disabled. |
| 415 | Unsupported content type. |
| 429 | Rate limited. |
| 500 | Server/config error; hide sensitive details in production. |

### 21.4 Browser form versus JSON response mode

Endpoints that accept either built-in form submissions or JSON must choose response mode from the request content type; `Accept` may be used only to choose the safest error rendering for malformed requests and must not override a supported content type.[^consume-response]

Rules:

- `Content-Type: application/json` selects JSON mode;
- `Content-Type: application/x-www-form-urlencoded` from built-in token/reset forms selects form mode;
- unsupported content types return `415` before parsing;
- built-in HTML form POSTs return `303` redirects on success;
- JSON requests return `200` JSON on success;
- JSON token-consume responses include `redirectTo` when a redirect target exists;
- invalid form submissions render or redirect to a minimal safe error page;
- invalid JSON submissions return the JSON error shape;
- never include raw tokens in redirect URLs after consumption.

### 21.5 `POST /auth/signup`

Request:

```json
{
  "email": "person@example.com",
  "username": "person",
  "password": "correct horse battery staple"
}
```

Response:

```json
{
  "user": {
    "id": "usr_...",
    "email": "person@example.com",
    "username": "person",
    "emailVerified": false,
    "createdAt": 1760000000000
  }
}
```

Default behavior:

- validate email/password/username
- normalize email and username
- rate-limit by IP and normalized email
- hash password
- create user
- send verification email if enabled
- create session unless `requireEmailVerificationBeforeSession` is true
- set session cookie if session created
- return `409` for duplicate email/username by default
- if `signup.enumerationSafe = true`, require email verification before session, return `{ "ok": true }` for valid input whether the account is new or already present, never set a session cookie in the signup response, and send verification email only when a new user can be created without violating email or username uniqueness

### 21.6 `POST /auth/login`

Request:

```json
{
  "identifier": "person@example.com",
  "password": "correct horse battery staple"
}
```

Response:

```json
{
  "user": {
    "id": "usr_...",
    "email": "person@example.com",
    "username": "person",
    "emailVerified": true,
    "createdAt": 1760000000000
  }
}
```

Default behavior:

- `identifier` may be email or username
- normalize an email-shaped identifier with the email normalization rules and a non-email identifier with the username normalization rules
- if the identifier cannot be normalized under the enabled method, still run the rate-limit and dummy password verification paths and return `invalid_credentials`
- rate-limit by IP and normalized identifier, using an HMACed invalid-identifier canonical value derived from trimmed, lowercased, length-capped input when normalization fails
- return generic `invalid_credentials` for missing user, missing password hash, or wrong password
- run dummy password verification when user is absent or has no password hash
- reject disabled accounts
- enforce `login.requireVerifiedEmail` if configured
- create session cookie
- log auth event

### 21.7 `POST /auth/logout`

Response:

```json
{
  "ok": true
}
```

Default behavior:

- accept an empty body with no `Content-Type`;
- enforce unsafe-method origin checks even when the body is empty;[^same-origin-logout]
- revoke current session row if present;
- clear cookie using the cookie-clearing rules;
- return `{ "ok": true }` even if already logged out

### 21.8 `GET /auth/user`

Authenticated response:

```json
{
  "user": {
    "id": "usr_...",
    "email": "person@example.com",
    "username": "person",
    "emailVerified": true,
    "createdAt": 1760000000000
  }
}
```

Unauthenticated response:

```json
{
  "user": null
}
```

### 21.9 `POST /auth/magic-link/request`

Request:

```json
{
  "email": "person@example.com",
  "redirectTo": "/dashboard"
}
```

Response:

```json
{
  "ok": true
}
```

Default behavior:

- always return `{ "ok": true }`
- validate and store `redirectTo` at request time
- create token only if user exists and is not disabled, unless `allowSignups` is enabled
- if `allowSignups` is enabled, store `normalized_email` and create/find the user during verification
- send email if applicable
- rate-limit by IP and normalized email
- token expires after 15 minutes by default
- previous active magic-link tokens for the same user/email are revoked by default

### 21.10 `GET /auth/magic-link/verify?token=...`

Default behavior:

- do **not** consume token
- do **not** create session
- parse only the raw token shape and expected purpose before rendering; do not perform D1 lookup, increment attempts, or write events on `GET`
- render minimal confirmation page with POST form
- include no third-party resources
- include no token in links except the hidden form field
- use `Referrer-Policy: no-referrer`

This avoids link scanners consuming login links.

### 21.11 `POST /auth/magic-link/consume`

Accepts form body or JSON:

```json
{
  "token": "..."
}
```

Default behavior:

- hash incoming token
- consume valid unused token in a D1 transaction/batch
- create user if `allowSignups` and user does not exist
- mark email verified by default for magic-link login
- create session
- set session cookie
- for form requests, redirect to stored safe redirect target or default
- for JSON requests, return `{ user, redirectTo }` and set the session cookie
- reject replay
- ignore any new `redirectTo` parameter

### 21.12 `POST /auth/email/verify/request`

Request:

```json
{
  "email": "person@example.com",
  "redirectTo": "/dashboard"
}
```

Response:

```json
{
  "ok": true
}
```

Default behavior:

- always return `{ "ok": true }`
- if user exists, is not disabled, and is unverified, revoke previous active verification tokens, create a new verification token, and send email
- if user does not exist or is already verified, do not reveal that fact
- rate-limit by IP and normalized email

### 21.13 `GET /auth/email/verify?token=...`

Default behavior:

- do **not** consume token
- do **not** mark email verified
- parse only the raw token shape and expected purpose before rendering; do not perform D1 lookup, increment attempts, or write events on `GET`
- render minimal confirmation page with POST form
- include no third-party resources
- use `Referrer-Policy: no-referrer`

### 21.14 `POST /auth/email/verify/consume`

Accepts form body or JSON:

```json
{
  "token": "..."
}
```

Default behavior:

- consume valid email verification token in a D1 transaction/batch
- mark user’s email verified
- optionally create a session if no session exists and config permits
- for form requests, redirect to stored safe redirect target or default
- for JSON requests, return `{ user, redirectTo }` and set a session cookie only if a session is created
- reject replay

### 21.15 `POST /auth/password/reset/request`

Request:

```json
{
  "email": "person@example.com",
  "afterResetRedirectTo": "/login"
}
```

Response:

```json
{
  "ok": true
}
```

Default behavior:

- always return `{ "ok": true }`;
- validate and store `afterResetRedirectTo` as the post-reset redirect target;
- if user exists and is not disabled, revoke previous active reset tokens, create a password reset token, and email a link;
- default reset email link points to built-in `/auth/password/reset?token=...`;
- token is not consumed when the reset page is opened;
- rate-limit by IP and normalized email;
- token expires after 30 minutes by default.

Custom reset page behavior:

- custom pages are opt-in through `passwordReset.resetPage: { mode: "custom", path: "/reset-password" }`;
- custom reset pages must strip the token from the URL immediately after loading;
- custom reset pages must use `Referrer-Policy: no-referrer`;
- custom reset pages must not include third-party scripts, images, analytics, or external styles while the token is present;
- docs must explain these requirements before showing a custom page example.[^reset-page]

### 21.16 `GET /auth/password/reset?token=...`

Default behavior:

- do **not** consume token;
- do **not** change password;
- parse only the raw token shape and expected purpose before rendering; do not perform D1 lookup, increment attempts, or write events on `GET`;
- render built-in minimal password reset form;
- include the token only in a hidden form field;
- include no third-party resources;
- use strict CSP and `Referrer-Policy: no-referrer`;
- submit by POST to `/auth/password/reset/confirm`.

### 21.17 `POST /auth/password/reset/confirm`

Request:

```json
{
  "token": "...",
  "password": "new correct horse battery staple"
}
```

Response:

```json
{
  "user": {
    "id": "usr_...",
    "email": "person@example.com",
    "username": "person",
    "emailVerified": true,
    "createdAt": 1760000000000
  },
  "redirectTo": "/login"
}
```

Default behavior:

- rate-limit by IP before token lookup;
- parse and HMAC the incoming token;
- run cheap password shape validation before token lookup;
- look up the token and reject malformed, expired, used, revoked, wrong-type, or disabled-user tokens before expensive password hashing;
- run `scrypt` only after the token row is known to be valid and active;[^reset-hash-order]
- consume the valid unused token and update password in a D1 transaction/batch;
- mark email verified by default;
- revoke existing sessions by default;
- optionally create a new session if configured;
- for form requests, redirect to stored post-reset redirect target or default;
- for JSON requests, return `{ user, redirectTo }` and set a session cookie only if a session is created;
- reject replay.

---

## 22. D1 Atomicity Patterns

### 22.1 General rule

Use `db.batch()` for multi-statement state changes. D1 batch statements are transactional; if a statement fails, the sequence rolls back.

Use `withSession("first-primary")` when sequential read-after-write consistency is needed outside a single batch, and for auth-state reads where stale data could accept a revoked session or consumed token.[^primary-auth-reads]

Migration and maintenance rules:

- D1 migration files must not include explicit `BEGIN` or `COMMIT` statements.
- Future table-rewrite migrations with foreign keys must use `PRAGMA defer_foreign_keys = on` when needed.[^d1-migration-fks]
- Runtime route handlers must not call `exec()` with dynamic input; trusted migration files are the only acceptable raw SQL input path.

### 22.2 Token consumption rules

Token consumption must be guarded by all of these conditions:

```sql
WHERE token_hash = ?
  AND type = ?
  AND used_at IS NULL
  AND consume_id IS NULL
  AND revoked_at IS NULL
  AND expires_at > ?
```

For user-bound token types, also require:

```sql
AND EXISTS (
  SELECT 1 FROM users
  WHERE users.id = verification_tokens.user_id
    AND users.disabled_at IS NULL
)
```

### 22.3 Required simple consume implementation

Use `consume_id` instead of `UPDATE ... RETURNING` so the required path is identical across local and remote D1.

```sql
UPDATE verification_tokens
SET used_at = ?, consume_id = ?, attempts = attempts + 1
WHERE token_hash = ?
  AND type = ?
  AND used_at IS NULL
  AND consume_id IS NULL
  AND revoked_at IS NULL
  AND expires_at > ?;
```

Then select by the generated consume ID in the same `db.batch()` call:

```sql
SELECT id, user_id, normalized_email, redirect_to, metadata_json
FROM verification_tokens
WHERE consume_id = ? AND type = ?;
```

The simple update must include the additional subject and disabled-user predicates from Section 22.2 when the token type is user-bound. After the batch, require the update statement to report `changes === 1` and the select to return exactly one row. A zero-change update means the token is missing, expired, used, revoked, wrong-type, disabled-user-bound, or otherwise invalid.

### 22.4 Transactional password reset pattern

Password reset confirm must perform cheap token validation before expensive password hashing, but must not consume the token until password hashing succeeds.[^reset-hash-order]

Required order:

1. parse token and reject malformed tokens;
2. apply IP rate limit;
3. run cheap password shape validation;
4. HMAC token and perform active-token lookup;
5. reject missing, expired, used, revoked, wrong-type, or disabled-user tokens;
6. run password hashing behind the semaphore;
7. consume token and update user/session state in one `db.batch()`.

Use one `db.batch()` call with subqueries keyed by `consume_id`.

Statements:

```sql
UPDATE verification_tokens
SET used_at = ?, consume_id = ?, attempts = attempts + 1
WHERE token_hash = ?
  AND type = 'password_reset'
  AND used_at IS NULL
  AND consume_id IS NULL
  AND revoked_at IS NULL
  AND expires_at > ?
  AND user_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM users
    WHERE users.id = verification_tokens.user_id
      AND users.disabled_at IS NULL
  );
```

```sql
UPDATE users
SET password_hash = ?,
    email_verified_at = CASE
      WHEN ? THEN COALESCE(email_verified_at, ?)
      ELSE email_verified_at
    END,
    updated_at = ?
WHERE id = (
  SELECT user_id FROM verification_tokens
  WHERE consume_id = ? AND type = 'password_reset'
);
```

```sql
-- Include this statement only when passwordReset.revokeExistingSessions is true.
UPDATE sessions
SET revoked_at = ?
WHERE revoked_at IS NULL
  AND user_id = (
    SELECT user_id FROM verification_tokens
    WHERE consume_id = ? AND type = 'password_reset'
  );
```

Optional session creation, included only when `passwordReset.createSessionAfterReset` is true:

```sql
INSERT INTO sessions (
  id, user_id, token_hash, created_at, expires_at, user_agent_hash, ip_hash
)
SELECT ?, user_id, ?, ?, ?, ?, ?
FROM verification_tokens
WHERE consume_id = ? AND type = 'password_reset';
```

Event insert:

```sql
INSERT INTO auth_events (
  id, user_id, event_type, created_at, ip_hash, user_agent_hash, metadata_json
)
SELECT ?, user_id, 'password_reset_success', ?, ?, ?, '{}'
FROM verification_tokens
WHERE consume_id = ? AND type = 'password_reset';
```

User select:

```sql
SELECT * FROM users
WHERE id = (
  SELECT user_id FROM verification_tokens
  WHERE consume_id = ? AND type = 'password_reset'
);
```

After batch:

- require first statement `changes === 1`;
- require user row exists;
- require optional session insert `changes === 1` when a new session is configured;
- allow session revocation `changes === 0` because a user may have no active sessions;
- if first statement changes `0`, return invalid/expired/used/revoked token;
- if any statement throws, D1 rolls back the batch;
- build the batch statement list from config instead of running disabled optional side effects.[^batch-config-branches]

### 22.5 Transactional email verification pattern

Use the same `consume_id` batch pattern:

1. guarded update token
2. update user `email_verified_at`
3. optional session insert
4. event insert
5. select user

### 22.6 Transactional magic-link pattern

Default MVP has `allowSignups = false`.

For default user-bound magic links, use one `db.batch()` call:

1. guarded update token with `type='magic_link'`, `user_id IS NOT NULL`, `normalized_email IS NULL`, active-token predicates from Section 22.2, and disabled-user predicate from Section 22.2;
2. update user `email_verified_at = COALESCE(email_verified_at, now)`;
3. insert session from the token’s `user_id`;
4. insert auth event;
5. select user and session.

For `allowSignups = true`, implement after the default magic-link consume path inside Stage 4 and before Stage 4 is accepted. The runtime pre-generates `newUserId`, `sessionId`, `sessionTokenHash`, and `consumeId`; the repository receives only those derived/persistence values, not raw tokens.

Required batch order for JIT-signup magic-link tokens:

```sql
UPDATE verification_tokens
SET used_at = ?, consume_id = ?, attempts = attempts + 1
WHERE token_hash = ?
  AND type = 'magic_link'
  AND used_at IS NULL
  AND consume_id IS NULL
  AND revoked_at IS NULL
  AND expires_at > ?
  AND user_id IS NULL
  AND normalized_email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE users.normalized_email = verification_tokens.normalized_email
      AND users.disabled_at IS NOT NULL
  );
```

```sql
INSERT OR IGNORE INTO users (
  id, email, normalized_email, username, normalized_username,
  password_hash, email_verified_at, created_at, updated_at, metadata_json
)
SELECT ?, normalized_email, normalized_email, NULL, NULL, NULL, ?, ?, ?, '{}'
FROM verification_tokens
WHERE consume_id = ? AND type = 'magic_link';
```

```sql
UPDATE verification_tokens
SET user_id = (
      SELECT users.id
      FROM users
      WHERE users.normalized_email = verification_tokens.normalized_email
        AND users.disabled_at IS NULL
    ),
    normalized_email = NULL
WHERE consume_id = ?
  AND type = 'magic_link'
  AND user_id IS NULL
  AND normalized_email IS NOT NULL;
```

```sql
INSERT INTO sessions (
  id, user_id, token_hash, created_at, expires_at, user_agent_hash, ip_hash
)
SELECT ?, user_id, ?, ?, ?, ?, ?
FROM verification_tokens
WHERE consume_id = ? AND type = 'magic_link' AND user_id IS NOT NULL;
```

Then insert the `magic_link_login` auth event and select the user/session by `consume_id`.

After batch:

- require the token update `changes === 1`;
- require the token subject update `changes === 1`;
- require the session insert `changes === 1`;
- allow the `INSERT OR IGNORE INTO users` statement to report `changes === 0` when an enabled user already exists for the normalized email;
- reject the consume if the selected user row is missing or disabled;
- if any statement throws, D1 rolls back the batch.

This pattern consumes the token before user/session creation inside the same transaction, resolves the user by the token’s normalized-email subject, and relies on `UNIQUE(normalized_email)` plus the guarded consume update to make concurrent consumes deterministic.

Stage 4 is not complete until `allowSignups = true` passes the race tests listed in Section 31.4.

---

## 23. Rate Limiting

### 23.1 MVP limiter

D1 fallback rate limiting is part of the MVP and must be implemented before public examples claim production readiness.

### 23.2 Key derivation

Rate-limit key format before storage:

```text
rl:v1:<action>:<subject-type>:<base64url(hmac(rate-limit-key-hmac, action || "\0" || subject-type || "\0" || canonical-subject))>
```

Subject types:

| Subject type | Canonical subject |
|---|---|
| `ip` | Canonical IP address from Cloudflare request metadata or safe fallback bucket. |
| `email` | Normalized email. |
| `identifier` | Normalized login identifier, or an invalid-identifier canonical value derived from trimmed, lowercased, length-capped input when normalization fails. |

Rules:

- include both `action` and `subject-type` in the stored key and HMAC message;
- use a delimiter that cannot be confused with subject data, such as `\0`;
- never store raw email, raw identifier, or raw IP in `rate_limits.key`;
- invalid login identifiers must be trimmed, lowercased, length-capped, and passed only into the HMAC derivation path, never stored raw;
- tests must prove that the same string value used as different subject types does not collide.[^rate-limit-key-namespace]

### 23.3 Default limits

| Action | Subject | Limit |
|---|---|---:|
| Password login | IP | 10 / 10 minutes |
| Password login | normalized identifier | 5 / 10 minutes |
| Signup | IP | 5 / hour |
| Signup | normalized email | 3 / hour |
| Magic link request | normalized email | 3 / 15 minutes |
| Magic link request | IP | 10 / 15 minutes |
| Password reset request | normalized email | 3 / hour |
| Password reset request | IP | 10 / hour |
| Email verification request | normalized email | 3 / hour |
| Email verification request | IP | 10 / hour |
| Magic-link consume | IP | 30 / 15 minutes |
| Email-verification consume | IP | 30 / hour |
| Password-reset confirm | IP | 10 / hour |

Rate limit response:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many attempts. Try again later."
  }
}
```

### 23.4 Optional Cloudflare Rate Limiting API adapter

Use Cloudflare Workers Rate Limiting API as an optional edge-abuse prefilter only.[^edge-prefilter]

Rules:

- It supports short windows of `10` or `60` seconds.
- It requires a configured `ratelimits` binding and a compatible Wrangler version.
- It is local/permissive/eventually consistent.
- It must not replace D1 rate limiting for account-sensitive actions.
- If enabled, check it before D1 to reduce load.
- Still apply authoritative D1 fixed-window limits.
- Production docs must recommend a Cloudflare Rate Limiting API prefilter, WAF rule, or Turnstile for signup, magic-link request, password-reset request, and token consume endpoints.

---

## 24. Email System

### 24.1 Email adapter interface

Email adapters receive runtime context so Worker bindings are accessed from `env` at request time, not at module import time.[^email-runtime]

```ts
export interface AuthEmailRuntime<Env = unknown> {
  env: Env;
  ctx: ExecutionContext;
  mode: "development" | "preview" | "production";
  requestId: string;
  publicOrigin: string;
  logger: AuthLogger;
}

export interface AuthEmailAdapter<Env = unknown> {
  sendMagicLink(input: SendMagicLinkInput, runtime: AuthEmailRuntime<Env>): Promise<void>;
  sendEmailVerification(input: SendEmailVerificationInput, runtime: AuthEmailRuntime<Env>): Promise<void>;
  sendPasswordReset(input: SendPasswordResetInput, runtime: AuthEmailRuntime<Env>): Promise<void>;
}
```

Rules:

- adapters must not read Worker bindings at module initialization time;
- adapter factories may store binding names, not binding instances;
- `cloudflareEmail({ binding: "AUTH_EMAIL" })` resolves `runtime.env.AUTH_EMAIL` inside each send method;
- custom adapters may use `runtime.env` for API keys or service bindings;
- runtime loggers must redact tokens, links, passwords, and secrets.

### 24.2 Dev terminal adapter

Local dev default:

```text
[cf-auth dev email]
Magic link for person@example.com:
http://localhost:8787/auth/magic-link/verify?token=...
```

Rules:

- terminal email is default in `development`
- terminal email is rejected in `preview` and `production` unless a test harness explicitly injects it outside deployed Workers[^terminal-email]
- no production email provider needed for local auth
- when `terminalEmail({ outbox: true })` is configured, store messages in memory for the dev outbox and tests

### 24.3 Dev outbox route

Route:

```text
GET /auth/dev/emails
```

Rules:

- only available when `AUTH_ENV=development`
- must return `404` in preview/production
- can be disabled explicitly
- is an in-memory, per-isolate development convenience and must not be treated as durable storage[^dev-outbox-memory]
- must not expose raw emails or raw token links in production or preview logs

### 24.4 Cloudflare Email adapter

Requirements:

- send via Workers `send_email` binding resolved from runtime `env`
- generated binding name: `AUTH_EMAIL`
- support HTML and plaintext
- configurable `from`
- configurable app name
- custom template hooks
- clear error if binding missing
- `doctor` verifies binding exists and production constraints are documented
- adapter types must track the Cloudflare Email binding shape closely enough that future Email Service additions do not require auth core changes[^email-binding-type]

Binding type:

```ts
export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name?: string };
    attachments?: Array<{
      content: string | ArrayBuffer;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}
```

### 24.5 Custom email adapter

Provide docs and examples for:

- Resend
- Postmark
- user-defined async sender

Do not make these core dependencies.

### 24.6 Email send failure policy

Email request endpoints with enumeration risk:

- `POST /auth/magic-link/request`
- `POST /auth/password/reset/request`
- `POST /auth/email/verify/request`

Rules:

- always return `{ "ok": true }`
- if DB token creation succeeds but email send fails, log `email_send_failed`
- do not reveal account existence
- in development, optional debug output may be printed to terminal only

Signup:

- If `signup.enumerationSafe = true`, always return `{ "ok": true }` for valid input even when verification email sending fails; log `email_send_failed` and rely on resend verification.
- If normal signup creates a user, verification is required before session, and the initial verification email fails, return `500` with `email_send_failed` in production because no session cookie is set for the new user in that response.
- If normal signup creates a session and verification email fails, return the user/session response, log `email_send_failed`, and allow the user to request another verification email.
- Always log `email_send_failed`.

### 24.7 Templates

Provide default templates for:

- magic link
- email verification
- password reset

Rules:

- short subject
- app name included
- expiration included
- plaintext fallback
- no tracking pixels
- no third-party assets

---

## 25. Browser Client SDK

### 25.1 API

```ts
import { createAuthClient } from "@cf-auth/client";

const auth = createAuthClient({ basePath: "/auth" });

await auth.signUp({ email, username, password });
await auth.signInWithPassword({ identifier, password });
await auth.signInWithMagicLink({ email, redirectTo: "/dashboard" });
await auth.signOut();
const { user } = await auth.getUser();
await auth.requestEmailVerification({ email, redirectTo: "/dashboard" });
await auth.requestPasswordReset({ email, afterResetRedirectTo: "/login" });
await auth.resetPassword({ token, password });
```

### 25.2 SDK rules

- browser-safe
- no Node-only imports
- uses `fetch`
- sends `credentials: "include"` by default
- small bundle
- typed responses
- typed errors
- works same-origin by default
- framework-agnostic

---

## 26. Hono and Worker Integration

### 26.1 Hono example

```ts
import { Hono } from "hono";
import { createAuthRoutes, getAuthUser, requireUser, requireVerifiedUser } from "@cf-auth/hono";
import authConfig from "./auth.config";

type Env = {
  Bindings: {
    AUTH_DB: D1Database;
    AUTH_SECRET: string;
    AUTH_SECRET_PREVIOUS?: string;
    AUTH_EMAIL?: unknown;
    AUTH_ENV?: string;
    AUTH_PUBLIC_ORIGIN?: string;
  };
};

const app = new Hono<Env>();

app.route(authConfig.basePath, createAuthRoutes(authConfig));

app.get("/api/me", requireUser(), async (c) => {
  const user = getAuthUser(c);
  return c.json({ user });
});

export default app;
```

### 26.2 Plain Worker example

```ts
import { createAuthHandler } from "@cf-auth/worker";
import authConfig from "./auth.config";

const authHandler = createAuthHandler(authConfig);

export default {
  async fetch(request, env, ctx) {
    const authResponse = await authHandler.fetch(request, env, ctx);
    if (authResponse) return authResponse;

    return new Response("Not found", { status: 404 });
  },
};
```

### 26.3 Helper functions

Expose:

- `getSession(request, env, ctx, config)`
- `getUser(request, env, ctx, config)`
- `requireUser()`
- `requireVerifiedUser()`[^verified-user]
- `optionalUser()`
- `getAuthUser(c)` for Hono

---

## 27. CLI Design

The CLI is a product surface, not a thin utility.

### 27.1 Commands

Required v1 commands:

```bash
cf-auth init
cf-auth migrate
cf-auth deploy
cf-auth doctor
cf-auth generate
cf-auth rotate-secret
cf-auth clean
cf-auth users disable
cf-auth users enable
cf-auth sessions revoke
cf-auth sessions list
```

Do not ship undocumented command aliases. `cf-auth upgrade` and `cf-auth add turnstile` are not v1 commands; upgrades are handled through versioned migrations, release notes, and the upgrade guide, and Turnstile is configured through `auth.config.ts` plus `docs/turnstile.md`.

### 27.2 `cf-auth init`

Modes:

- new Hono Worker app
- existing Hono app
- existing plain Worker app

Standalone auth Worker scaffolding is not offered by the v1 `init` command; Section 5.2 describes a future architecture only.

Prompts:

```text
What are you building?
  - New Cloudflare Worker + Hono app
  - Add to existing Hono app
  - Add to existing plain Worker app

Which auth methods?
  [x] Email/password
  [x] Username/password
  [x] Magic link

Use Cloudflare Email in production?
  - Yes, use Cloudflare Email Service
  - Not yet, use terminal/custom adapter

Create D1 database automatically?
  - Yes
  - I already have one

Mount auth where?
  /auth
```

Outputs:

- `auth.config.ts`
- updated `wrangler.jsonc` or `wrangler.toml`
- migrations
- new-project templates for Hono Worker and plain Worker modes
- route mount snippet or safe route patch
- `.dev.vars.example`
- `.env.example` if applicable
- README next steps

Patch rules:

- Use AST transforms only when app structure is recognized.
- If confidence is low, do not mutate source files; print snippets.
- Never overwrite user files without backup or diff confirmation.
- `--yes` may auto-apply only recognized safe patches; it must still create backups or operate on newly generated files.
- Support `--yes` for CI/template mode.
- Support `--dry-run`.
- Support `--repair` to re-run safe config, migration, and route-mount patching without overwriting user source files.

### 27.3 `cf-auth migrate`

Flags:

```bash
cf-auth migrate --local
cf-auth migrate --remote --env production
cf-auth migrate --status --local
cf-auth migrate --status --remote --env production
cf-auth migrate --dry-run --remote --env production
```

Rules:

- wrap Wrangler D1 migrations;
- require exactly one target mode: `--local` or `--remote`;
- require `--env <name>` for remote migrations when the Wrangler config uses named environments;
- fail remote migrations without `--env` when the top-level config is development or ambiguous;
- detect database name/binding from the selected config environment;
- print exact underlying command in verbose mode;
- fail clearly if database binding is missing;
- check `auth_schema_migrations` after migration.

### 27.4 `cf-auth doctor`

Flags:

```bash
cf-auth doctor
cf-auth doctor --env production
cf-auth doctor --report
cf-auth doctor --report --env production
cf-auth doctor --report --env production --output auth-doctor-report.json
```

Rules:

- human-readable `doctor` is implemented in Stage 7; `--report` is implemented in Stage 10 before private alpha;
- `--report` writes a redaction-safe JSON diagnostic report to stdout unless `--output <path>` is supplied;
- reports must not include raw secrets, raw tokens, raw cookies, raw emails, raw IP addresses, or raw user agents;
- human-readable output remains the default.

Checks:

- package versions
- CLI shim and scoped CLI consistency
- Wrangler version and availability
- Cloudflare login state
- account selection
- Worker config exists
- named environment exists when `--env` is supplied
- non-inheritable `vars` and bindings are present in the selected Wrangler environment
- D1 binding exists
- selected environment has no unresolved D1 `database_id` placeholder
- local D1 works
- migrations applied
- `auth_meta.schema_version` matches latest migration
- `auth_schema_migrations` includes all required migrations
- `AUTH_SECRET` exists
- local `AUTH_SECRET` and `AUTH_SECRET_PREVIOUS` format/strength when readable
- remote `AUTH_SECRET` and configured `AUTH_SECRET_PREVIOUS` existence when not readable
- Cloudflare Email binding exists when selected
- Cloudflare Email beta/Paid/DNS constraints are documented
- cookie config matches environment/origin mode
- allowed redirect origins are valid
- `publicOrigin` configured in preview and production when email links can be generated
- password hashing benchmark sanity check passes
- Turnstile secret exists if Turnstile is required
- dev outbox disabled in production
- auth route mounted once, not `/auth/auth`

Output example:

```text
✗ AUTH_SECRET is missing remotely
  Fix: npx cf-auth@latest rotate-secret --apply --env production

✗ D1 migration 0002_indexes.sql has not been applied remotely
  Fix: npx cf-auth@latest migrate --remote --env production

✗ Production public origin is missing
  Fix: set AUTH_PUBLIC_ORIGIN=https://example.com or configure runtime.publicOrigin

✓ Local terminal email enabled
✓ Auth route mounted at /auth
```

Important limitation:

- Worker secrets generally cannot be read back safely. `doctor` can check remote secret existence, not remote secret strength, unless it generated and stored metadata locally.

### 27.5 `cf-auth deploy`

Flow:

1. run `doctor`
2. reject ambiguous top-level deploys unless the selected environment is production-safe
3. check migrations against the selected remote deployment environment
4. apply remote migrations for the selected environment if `--migrate`
5. deploy through Wrangler with the selected environment
6. print endpoints
7. print any remaining external Cloudflare Email/DNS setup steps

Flags:

```bash
cf-auth deploy
cf-auth deploy --migrate
cf-auth deploy --dry-run
cf-auth deploy --env production
```

### 27.6 `cf-auth generate`

Examples:

```bash
cf-auth generate types
cf-auth generate hono
cf-auth generate react-client
cf-auth generate worker-snippet
```

### 27.7 `cf-auth rotate-secret`

MVP behavior:

- generate new `AUTH_SECRET`
- optionally set it remotely through Wrangler
- warn if old remote secret cannot be preserved
- support `AUTH_SECRET_PREVIOUS` when old value is known

Commands:

```bash
cf-auth rotate-secret --print
cf-auth rotate-secret --apply --env production
cf-auth rotate-secret --apply --previous-from-stdin --env production
cf-auth rotate-secret --apply --previous-from-env AUTH_SECRET_OLD --env production
```

Rules:

- Do not accept a previous raw secret as an inline command argument.[^secret-cli-input]
- If old secret is unknown, warn that existing sessions/tokens will be invalidated.
- Do not claim seamless rotation unless previous secret is configured.

### 27.8 `cf-auth clean`

Deletes:

- expired sessions
- expired verification tokens
- expired rate limit rows
- old auth events beyond retention

Flags:

```bash
cf-auth clean --local
cf-auth clean --remote --env production
cf-auth clean --dry-run --remote --env production
```

### 27.9 Account recovery helper commands

These are operational recovery helpers, not a hosted dashboard or role system.[^admin-recovery]

Commands:

```bash
cf-auth users disable <user-id-or-email> --local
cf-auth users enable <user-id-or-email> --local
cf-auth sessions revoke --user <user-id-or-email> --remote --env production
cf-auth sessions list --user <user-id-or-email> --remote --env production
```

Rules:

- commands require explicit local/remote target flags and `--env <name>` for named remote environments;
- destructive commands support `--dry-run`;
- user lookup by email must normalize email before lookup;
- disabling a user does not delete their data;
- disabling a user must cause existing sessions to be rejected and must revoke active sessions;
- enabling a user does not automatically verify email or reset password;
- session listing output must include session IDs, creation/expiry/revocation timestamps, and last-seen timestamps only; it must not print raw session tokens, token hashes, raw IPs, raw user agents, or cookies.

### 27.10 Scheduled cleanup recipe

Docs must include a scheduled Worker recipe:

```ts
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanCfAuth({ env, config: authConfig }));
  },
};
```

Default retention:

| Table | Retention |
|---|---:|
| expired sessions | delete after 7 days |
| used/revoked/expired verification tokens | delete after 7 days |
| expired rate limit rows | delete after 24 hours |
| auth events | keep 90 days by default |

---

## 28. Security Model

### 28.1 Threat model

Document and test mitigations for:

- account enumeration
- credential stuffing
- brute-force login
- reset email abuse
- magic-link abuse
- email link scanners
- token replay
- token leakage through logs/referrers/history
- open redirects
- CSRF
- session theft
- session fixation
- D1 consistency/concurrency
- email delivery failure
- secret rotation
- permissive CORS middleware
- raw PII in logs/rate-limits/events

### 28.2 Enumeration resistance

Always generic in response shape:

- magic-link request
- password-reset request
- email-verification request

Timing-hardening requirements:[^enumeration-timing]

- run rate limits before identity-specific branching;
- use `ctx.waitUntil` for email sending where response latency would otherwise reveal whether an account exists;
- perform dummy token/HMAC work for absent-account branches by deriving an action-specific dummy token hash with the request key ring before returning;
- use a small minimum response latency with jitter for enumeration-sensitive request endpoints when configured;
- do not claim perfect timing indistinguishability across networks, Workers isolates, and email-provider behavior.

Generic login:

- missing account and wrong password both return `invalid_credentials`;
- dummy password verification must run for absent accounts and null-password accounts.

Signup:

- default may return duplicate email/username as `409`;
- document this explicitly;
- support `signup.enumerationSafe: true`.

### 28.3 Auth event hashing

Hash IP and user-agent with purpose-specific subkeys.

```text
ip_hash = base64url(hmac(event-ip-hash, canonicalIp))
user_agent_hash = base64url(hmac(event-user-agent-hash, userAgent))
```

Do not store raw values in `auth_events`.

### 28.4 Disabled users

Rules:

- disabled users cannot log in
- disabled users cannot consume magic links
- disabled users cannot reset passwords
- existing sessions for disabled users must be rejected even if not revoked

### 28.5 Password reset semantics

Default:

- password reset marks email verified
- password reset revokes existing sessions
- password reset does not create a new session unless configured

### 28.6 Magic-link semantics

Default:

- magic-link login marks email verified
- magic-link signup disabled unless configured
- magic-link `GET` does not consume
- magic-link `POST` consumes and creates session

### 28.7 Email verification semantics

Default:

- email verification marks email verified
- email verification does not create session unless configured
- email verification `GET` does not consume
- email verification `POST` consumes

### 28.8 Log redaction

All runtime, CLI, test, and adapter logs must use a shared redaction utility.[^log-redaction]

Redact:

- raw session cookies;
- raw magic-link, email-verification, and password-reset tokens;
- full URLs containing token query params;
- passwords and password confirmation fields;
- `AUTH_SECRET` and previous secrets;
- email provider API keys;
- raw email addresses in auth event metadata unless the developer explicitly opts into PII logging;
- raw IP addresses and raw user agents.

Tests must intentionally throw errors containing token URLs and assert that emitted logs, errors, and auth events do not contain raw token values.

### 28.9 Operational metrics

Expose counters or documented event queries for:[^metrics]

- successful and failed password logins;
- dummy verification path count;
- signup attempts and duplicate signup attempts;
- magic-link, verification, and reset email requests;
- email send failures;
- rate-limit hits;
- token consume success, replay, expired, malformed, and revoked outcomes;
- password reset successes and session revocations;
- disabled-user authentication attempts;
- config/runtime failures.

Metrics must avoid raw PII. Use HMACed or aggregate dimensions only.

### 28.10 Verified-user access control

Provide a first-class `requireVerifiedUser()` middleware and equivalent plain Worker helper.[^verified-user]

Rules:

- `requireUser()` requires a valid session;
- `requireVerifiedUser()` requires a valid session and `email_verified_at IS NOT NULL`;
- docs must show when to use each helper;
- route-level authorization remains the application’s responsibility in v1.

### 28.11 Host and request-origin validation

Host validation and request-origin validation are separate controls.[^host-validation]

Rules:

- production requests must match the host of configured `publicOrigin`, configured custom domains, or explicitly configured trusted hosts;
- preview requests must match configured preview hosts/origins, not arbitrary workers.dev or preview URLs unless explicitly allowed;
- local development may use trusted localhost hosts;
- host matching uses `new URL(request.url).host` after lowercasing and default-port normalization;
- `trustedHosts` entries are exact `host` or `host:port` values; wildcard hosts are not supported in v1;
- an untrusted host returns `403` before route handling, redirect validation, cookie decisions, or email-link generation;
- unsafe browser mutations must pass the origin policy in Section 19;
- CORS allowlists must not be reused as redirect allowlists unless the value is intentionally present in both lists.

---

## 29. Turnstile

Turnstile is optional in MVP but architecture must support it.

Config shape:

```ts
type TurnstileEndpoint =
  | "signup"
  | "password_login"
  | "magic_link_request"
  | "email_verification_request"
  | "password_reset_request"
  | "magic_link_consume"
  | "email_verification_consume"
  | "password_reset_confirm";

turnstile: {
  mode: "disabled" | "optional" | "required";
  endpoints: TurnstileEndpoint[];
}
```

Rules:

- verify token server-side;
- fail closed when required;
- validate Turnstile before account-specific branching, token lookup, token consume, and password hashing on protected endpoints;[^turnstile-order]
- do not enable in default quickstart;
- do not reuse tokens;
- reject unknown endpoint names during static config validation;
- configure through `auth.config.ts` and `docs/turnstile.md`; no `cf-auth add turnstile` command is shipped in v1.

---

## 30. Implementation Stages

Each stage must end in a useful repo state.

### Stage 0 — Repo identity and documentation skeleton

Deliverables:

- `README.md` draft
- `LICENSE`
- `SECURITY.md`
- `CONTRIBUTING.md`
- docs skeleton with every file listed in Section 33.2
- `docs/decisions/package-naming.md`
- `docs/non-goals.md`

Acceptance criteria:

- `README.md` contains a project summary of 150 words or fewer, a local quickstart outline, the independent-project disclaimer, and a link to `docs/non-goals.md`
- `docs/non-goals.md` lists every v1 exclusion from Section 0.3 and does not describe excluded items as planned v1 work
- `docs/decisions/package-naming.md` defines the public package names, CLI binary name, approved fallback scope, `npx cf-auth` availability rule, and scoped fallback commands from Section 1.3
- `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` exist at the repo root
- no public quickstart in `README.md` or `docs/quickstart.md` uses a package command that contradicts `docs/decisions/package-naming.md`

### Stage 1 — Monorepo and tooling

Deliverables:

- pnpm workspace
- package directories
- TypeScript config
- tsup config
- Vitest config
- Workers Vitest pool setup
- Changesets
- GitHub Actions CI
- exact `packageManager` pin and version matrix from Section 7.11
- root scripts for `format:check`, `lint`, `typecheck`, `test`, `build`, `package:check`, and `version-matrix:check`

Acceptance criteria:

- `pnpm install --frozen-lockfile` succeeds from a clean clone
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm package:check`, and `pnpm version-matrix:check` all succeed
- empty package entrypoints build with JavaScript output and `.d.ts` declarations
- package export-map tests import every public entrypoint without relying on deep imports
- CI runs the same commands listed in Section 32.1

### Stage 2 — D1 migrations, repositories, and rate-limit storage

Deliverables:

- `0001_initial.sql`
- `0002_indexes.sql`
- repository row types and input/output contracts in `@cf-auth/core`
- D1 repository implementation in `@cf-auth/worker`
- D1 fallback fixed-window rate-limit repository using opaque derived keys
- local migration test helper
- repository tests

Acceptance criteria:

- fresh DB migrates locally
- `auth_schema_migrations` and `auth_meta.schema_version` are correct
- unique email/username constraints work
- sessions can be created/read/revoked with fixture HMAC envelope values
- token rows can be inserted with fixture HMAC envelope values and consumed once
- token rows cannot be both consumed and revoked, and `used_at`/`consume_id` plus `revoked_at`/`revoked_reason` invariants are enforced by schema tests
- expired sessions/tokens are rejected
- rate limits do not collide across actions
- rate-limit repository tests use opaque HMAC-shaped keys and never require raw email/IP input
- repository tests prove token repositories never return or generate raw token material
- metadata JSON constraints are tested
- previous active tokens can be revoked without marking them used
- verification-token subject invariants are enforced by schema and repository tests
- future migration helpers use `PRAGMA defer_foreign_keys` when table rewrites require temporary FK deferral

### Stage 3 — Crypto, passwords, tokens, and sessions

Deliverables:

- random ID/token module
- base64url module
- key-ring parser
- HKDF subkey derivation
- token HMAC module
- rate-limit key derivation module
- IP and user-agent canonicalization/hash module
- password scrypt module
- hash envelope parser
- dummy password verification path
- session token/cookie module
- benchmark script

Acceptance criteria:

- password hashes include algorithm/version/params/maxmem/salt
- invalid passwords fail
- absent-user login runs dummy verification
- `needsRehash` works
- session tokens are never stored raw
- token hashes are deterministic for lookup and secret-bound
- rate-limit keys are HMACed, action-scoped, subject-type-scoped, and collision-tested across subject types
- cookie flags/names are correct in dev/prod/cross-subdomain modes
- token parser handles underscores in `kid` and random values without delimiter ambiguity
- key-ring parser rejects duplicate `kid` values across current and previous secrets

### Stage 4 — Auth HTTP runtime

Deliverables:

- Worker route handlers
- email adapter runtime interface and mock adapter for route tests
- D1 rate-limit integration
- Zod schemas
- error model
- response security headers
- redirect validator
- confirmation pages for magic/verify links
- endpoint tests

Acceptance criteria:

- signup/login/logout/user works locally against migrated D1
- magic-link request and confirmation-post consume flow works with the mock email adapter
- email verification confirmation-post flow works with the mock email adapter
- built-in password reset page and confirm flow work with the mock email adapter
- unsafe redirects fail
- replayed tokens fail
- generic responses protect enumeration-sensitive endpoints
- token `GET` routes parse only token shape, perform no D1 state lookup/write, and do not consume tokens
- JSON and form token consume responses follow the content-negotiation contract
- oversized request bodies are rejected before parsing
- unsafe browser mutations reject missing or unknown origins according to the origin policy
- CORS preflight responses are `204` for allowed origins and `403` for disallowed origins, with no wildcard credentialed CORS
- redirect validation rejects encoded protocol-relative and backslash variants
- route-level rate limiting writes only derived keys and never raw email/IP/identifier values
- feature-disabled endpoints return `404` with no side effects
- enumeration-safe signup returns a generic response and does not set a session cookie
- magic-link `allowSignups = true` passes JIT signup race tests and creates at most one user/session for concurrent consumes of the same token/email

### Stage 5 — Email adapters and templates

Deliverables:

- terminal email adapter
- dev outbox
- Cloudflare Email adapter
- default templates
- custom template hooks
- docs for email setup

Acceptance criteria:

- local links print to terminal
- preview and production reject terminal email adapters
- dev outbox works only in development
- Cloudflare Email adapter sends with configured binding
- missing binding produces clear `doctor` error
- templates are customizable
- email send failure policy is implemented

### Stage 6 — Hono, plain Worker, and client SDK

Deliverables:

- Hono adapter
- plain Worker adapter
- route protection helpers, including verified-user helpers
- browser client SDK

Acceptance criteria:

- Hono route mount is fewer than 10 lines
- no `/auth/auth` double-prefix bug
- protected Hono route works
- plain Worker path documented
- SDK works with same-origin `/auth`
- SDK has typed errors

### Stage 7 — CLI MVP

Deliverables:

- `cf-auth` shim
- `create-cloudflare-auth` entry package
- minimal Hono Worker and plain Worker templates used by `cf-auth init`
- `cf-auth init`
- `cf-auth migrate`
- `cf-auth doctor`
- `cf-auth deploy`
- `cf-auth generate`
- `cf-auth clean`
- `cf-auth rotate-secret`
- project detection
- Wrangler wrapper
- CLI tests and snapshots
- account recovery helper commands

Acceptance criteria:

- using local package tarballs produced by the Stage 7 build, a scripted smoke test from a clean temporary directory can run the `create-cloudflare-auth` entrypoint, apply local migrations, start/build the generated app, and exercise signup/login without manual edits
- an existing Hono fixture app is patched or given snippets according to the confidence rules, then builds and serves mounted auth routes at exactly one `/auth` prefix
- `doctor` exits nonzero and prints a redaction-safe fix for a missing D1 binding
- `doctor` exits nonzero and prints a redaction-safe fix for missing local and remote secrets
- `doctor` exits nonzero for invalid cookie prefix/secure/domain combinations in development, preview, and production fixtures
- `migrate --local`, `migrate --status --local`, `migrate --remote --env production`, and `migrate --status --remote --env production` construct the exact Wrangler commands and pass mocked Wrangler integration tests
- `deploy --dry-run --env production` runs `doctor`, checks remote migration status, and prints the exact Wrangler deploy command without mutating Cloudflare state
- CLI does not mutate unknown app source files; it prints route/config snippets and exits with a success status only after writing no source-file changes
- generated Wrangler config keeps local/default and production named-environment vars/bindings distinct
- remote migrations fail without `--env` when the top-level config is development or ambiguous
- account recovery helpers dry-run safely and never print tokens, token hashes, cookies, raw IPs, or raw user agents

### Stage 8 — Examples and docs

Deliverables:

- `examples/hono-basic`
- `examples/worker-basic`
- `examples/react-vite-worker`
- basic frontend forms in examples
- polished README
- docs pages for Stage 0 through Stage 8 implemented features listed in section 33
- `docs/turnstile.md` skeleton that states Turnstile is unavailable until Stage 9 passes and is not linked from quickstarts before that
- troubleshooting matrix

Acceptance criteria:

- examples run locally
- examples build in CI
- quickstart commands run from a clean generated app without undocumented manual steps, using local package tarballs before publication and published package names in prerelease/beta jobs
- every placeholder in quickstart and deployment docs is marked with the exact value the user must provide
- troubleshooting docs include exact fixes for missing D1 binding, missing secret, unapplied migrations, cookie misconfiguration, and email binding failures

### Stage 9 — Security hardening

Deliverables:

- optional Cloudflare Rate Limiting API adapter
- optional Turnstile verifier
- security regression tests
- cleanup command hardening
- scheduled cleanup recipe
- benchmark results
- log redaction tests
- password hashing concurrency tests
- final `docs/rate-limiting.md`, `docs/turnstile.md`, and `docs/security-model.md` updates for Stage 9 features

Acceptance criteria:

- brute-force attempts are rate-limited
- token consume endpoints are rate-limited
- email abuse endpoints are rate-limited
- open redirects fail
- token replay fails
- password reset revokes sessions
- Turnstile required mode validates before account-specific branching, token lookup/consume, and password hashing
- security docs contain a checklist item for each threat in Section 28.1 and each checklist item links to a passing regression test or documented mitigation

### Stage 10 — Private alpha

Deliverables:

- prerelease packages
- alpha instructions
- issue templates
- `doctor --report`
- patched docs based on feedback

Acceptance criteria:

- at least 5 alpha users complete local setup from a clean directory using the alpha instructions without maintainer-supplied shell commands outside the docs
- at least 3 alpha users complete production deploy using `cf-auth doctor --env production`, `cf-auth migrate --remote --env production`, and `cf-auth deploy --env production`
- median reported local setup time is under 10 minutes, measured from first scaffold command to successful signup/login
- `doctor --report --env production` emits redaction-safe JSON, validates against the checked-in report schema, and omits raw secrets, tokens, cookies, emails, IPs, and user agents
- at least 80% of alpha setup/deploy failures have either a `doctor` diagnostic or a troubleshooting entry with an exact fix before public beta starts

### Stage 11 — Public beta

Deliverables:

- beta packages
- public docs
- template repo
- Deploy to Cloudflare button
- known limitations doc

Acceptance criteria:

- published beta packages pass the documented quickstart from a clean directory in CI and in one manual maintainer verification
- production deploy smoke test passes with the documented `--env production` path against an opt-in Cloudflare account fixture
- Deploy to Cloudflare button creates the starter template, binds D1, applies migrations, and reaches a local or deployed signup/login smoke test according to the documented path
- security policy is published in `SECURITY.md`, linked from README, and includes supported versions, vulnerability-reporting channel, and expected response window

### Stage 12 — 1.0 readiness

Deliverables:

- stable API contract
- stable config schema
- upgrade guide
- release checklist
- security review decision record: completed external review or maintainer sign-off for release without one
- dependency review automation

Acceptance criteria:

- no unresolved issue or advisory labeled high/critical auth security remains open in the release tracker
- upgrade tests migrate every beta schema version to the 1.0 schema and preserve users, sessions, token invalidation semantics, and `auth_schema_migrations`
- examples use the current package versions, contain no workspace-only dependency references in published mode, and pass CI
- public API report is checked in, reviewed, and release-approved
- docs cover every public command, config key, endpoint, package entrypoint, migration command, and production setup step shipped in v1
- release automation publishes from a dry-run artifact whose package contents, README, LICENSE, export maps, and provenance settings pass `pnpm package:check`

---

## 31. Testing Plan

### 31.1 Unit tests

Test:

- email normalization
- username normalization
- password validation
- hash envelope parsing
- key-ring parsing
- duplicate key ID rejection
- HKDF key derivation
- token hashing
- redirect validation, including encoded slash/backslash variants and control characters
- request-origin validation
- CORS preflight validation and credentialed CORS header generation
- host validation
- config validation, including `basePath`, active-token policies, password-reset enablement, and request/redirect origin allowlists
- static config versus runtime config resolution
- cookie name/flag resolution
- error mapping
- request body size enforcement
- content-type parsing with parameters
- invalid feature-flag combinations, including verification-required configs with verification disabled and magic-link JIT signup with required usernames
- enumeration-safe signup static validation and response behavior

### 31.2 Repository tests

Run in Workers-compatible D1 test environment.

Test:

- migrations
- schema version tracking
- unique constraints
- user creation
- session lifecycle
- token creation/consumption
- token replay rejection
- revoked token rejection
- expired token rejection
- disabled user rejection
- session revocation
- primary-consistent auth-state reads for revoked sessions and consumed tokens
- D1 rate limiter
- rate-limit action/key collision prevention
- rate-limit subject-type collision prevention
- cleanup functions
- repository token insertion with fixture HMAC envelopes and no raw token returns

### 31.3 Route tests

Test full flows:

- signup -> user
- signup -> verification email
- login -> cookie
- absent-user login -> dummy hash path
- null-password user login -> dummy hash path
- logout -> revoked session
- magic link request -> terminal email -> GET confirmation parses token shape only, performs no D1 state lookup/write, and does not consume -> POST consume -> session
- email verification request -> GET confirmation parses token shape only, performs no D1 state lookup/write, and does not consume -> POST consume -> verified
- password reset request -> built-in reset page parses token shape only and performs no D1 state lookup/write -> confirm -> old sessions revoked
- current user
- invalid credentials
- unsafe redirect
- rate limited request
- disabled user cannot authenticate
- dev outbox unavailable in production
- CORS/origin rejection
- CORS preflight allows only configured origins, methods, and headers
- missing-origin unsafe browser request rejection
- unsupported cross-site credentialed CORS rejection
- JSON token consume returns JSON and form token consume redirects
- feature-disabled endpoints return `404` and write no rows, including `passwordReset.enabled = false`

### 31.4 Concurrency/security tests

Test:

- two concurrent token consume attempts produce one success
- two concurrent magic-link JIT signup consumes for the same normalized email produce at most one user and one successful session
- replay after success fails
- expired token plus valid token behavior
- password reset cannot leave password changed without consumed token
- magic-link GET scanners do not consume token
- rate-limit keys do not expose raw PII
- raw token never appears in event metadata
- raw token never appears in logs, thrown errors, or email adapter errors
- password reset confirm does not run scrypt for invalid tokens
- password hash semaphore limits concurrent hashes

### 31.5 CLI tests

Test:

- new project scaffold snapshots
- existing Hono app patching
- unknown app fallback snippets
- Wrangler config patching
- named-environment non-inheritable binding and var detection
- D1 binding detection
- migration command generation, including required `--env` for named remote environments
- doctor output
- deploy dry run
- package command docs consistency
- admin recovery helper dry runs

Mock actual Cloudflare network calls where needed. Keep one opt-in integration test suite for real Cloudflare accounts.

### 31.6 Example tests

Each example must pass:

```bash
pnpm install
pnpm build
pnpm test
```

The default example workflow must build and test every example. An opt-in `wrangler dev` smoke workflow must run at least one example against the Workers local runtime before public beta and 1.0.

---

## 32. CI and Release

### 32.1 GitHub Actions CI

`ci.yml` must run:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:check
pnpm version-matrix:check
```

### 32.2 Example workflow

`examples.yml` must verify example builds independently.

### 32.3 Release workflow

Use Changesets.

Requirements:

- publish packages from GitHub Actions with npm provenance enabled
- require npm publisher 2FA and scoped package ownership checks[^npm-hardening]
- generate changelog
- prevent publish if package names are unavailable/mismatched
- dry-run package output in CI
- ensure README and LICENSE included in packages
- check that public docs use only working package commands

### 32.4 Security automation

Add:

- Dependabot
- dependency review
- CodeQL for TypeScript
- secret scanning reminders
- `npm audit` as advisory, not sole security gate

---

## 33. Documentation Plan

Documentation must be written from day one.

### 33.1 `README.md`

Purpose: fastest successful path.

Must include:

1. what this is
2. independent-project disclaimer
3. 5-minute quickstart
4. add to existing Hono app
5. local dev email behavior
6. deploy to Cloudflare
7. security defaults
8. supported frameworks
9. troubleshooting links
10. non-goals

Do not lead with architecture theory. The README must clearly state that Cloudflare Auth is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Cloudflare.

### 33.2 Docs directory

| File | Purpose |
|---|---|
| `docs/decisions/package-naming.md` | Package names, CLI binary, create package, and fallback command rules. |
| `docs/non-goals.md` | v1 exclusions and scope boundaries from Section 0.3. |
| `docs/quickstart.md` | New app from zero to local auth. |
| `docs/existing-hono-app.md` | Add auth to existing Hono app. |
| `docs/existing-worker-app.md` | Add auth to plain Worker. |
| `docs/deployment.md` | Production deploy with `cf-auth deploy`. |
| `docs/cloudflare-email.md` | Cloudflare Email setup and constraints. |
| `docs/custom-email-adapter.md` | Use Resend/Postmark/custom sender. |
| `docs/local-development.md` | Terminal emails, local D1, dev outbox. |
| `docs/configuration.md` | Full config reference. |
| `docs/api.md` | Endpoint contract. |
| `docs/security-model.md` | Threat model and mitigations. |
| `docs/sessions-and-cookies.md` | Cookie/session details. |
| `docs/rate-limiting.md` | D1 and Cloudflare rate limiting. |
| `docs/turnstile.md` | Optional Turnstile setup. |
| `docs/migrations.md` | Migration lifecycle and upgrades. |
| `docs/troubleshooting.md` | Common errors and exact fixes. |
| `docs/roadmap.md` | What is next and what is not planned. |

### 33.3 Troubleshooting matrix

| Problem | Fix |
|---|---|
| `npx cf-auth` fails | Ensure the `cf-auth` package exists; otherwise use `npx --package @cf-auth/cli@latest cf-auth`. |
| Missing D1 binding | `npx cf-auth@latest init --repair` or edit `wrangler.jsonc`. |
| Migrations not applied | `npx cf-auth@latest migrate --local` or `npx cf-auth@latest migrate --remote --env production`. |
| Schema version mismatch | Run migrations; inspect `auth_schema_migrations`. |
| Missing `AUTH_SECRET` | `npx cf-auth@latest rotate-secret --apply --env production` for remote production, or generate `.dev.vars` for local development. |
| Cloudflare Email binding missing | Configure binding or switch to custom/terminal adapter. |
| Sender/domain not ready | Follow Cloudflare Email setup doc. |
| Cookie not set locally | Check that dev cookie is not `__Host-` on plain HTTP. |
| Cookie not set in production | Check HTTPS, `Secure`, `__Host-`, `Path=/`, and no `Domain`. |
| Cookie not sent | Check same-origin mode, CORS, SameSite, and fetch credentials. |
| Magic link opens but does not log in | Click confirmation button; GET does not consume by design. |
| Magic link redirect rejected | Add origin/path to the redirect allowlist, not the request-origin allowlist. |
| Local dev behaves like production | Ensure top-level Wrangler `vars.AUTH_ENV` is `development` and production vars are under `env.production`. |
| Deploy uses development settings | Run `npx cf-auth@latest doctor --env production`; bindings and vars must be repeated in the named environment. |
| Works locally but not deployed | Run `npx cf-auth@latest doctor --env production`. |
| Password hashing timeout | Run benchmark, reduce profile explicitly, check Worker plan, and inspect semaphore queue metrics. |
| Reset email says OK but no email arrives | Check email adapter logs and `email_send_failed` auth events. |
| JSON request returns `415` | Send `Content-Type: application/json`; charset parameters are allowed. |
| Cross-site frontend cannot stay logged in | Use same-origin or explicit same-site cross-origin mode; v1 does not support `SameSite=None` cross-site auth. |
| Reset token appears in analytics/referrer logs | Use the built-in reset page or remove all third-party resources and strip the token before loading app code. |

---

## 34. Source Notes

These sources were used to verify volatile platform/security assumptions on May 13, 2026:

- Cloudflare Wrangler docs: `https://developers.cloudflare.com/workers/wrangler/`
- Cloudflare D1 migrations: `https://developers.cloudflare.com/d1/reference/migrations/`
- Cloudflare D1 Worker Binding API: `https://developers.cloudflare.com/d1/worker-api/d1-database/`
- Cloudflare D1 foreign keys: `https://developers.cloudflare.com/d1/sql-api/foreign-keys/`
- Cloudflare Workers Wrangler configuration environments: `https://developers.cloudflare.com/workers/wrangler/configuration/#environments`
- Cloudflare Email Service overview: `https://developers.cloudflare.com/email-service/`
- Cloudflare Email Service pricing: `https://developers.cloudflare.com/email-service/platform/pricing/`
- Cloudflare Email Service Workers API: `https://developers.cloudflare.com/email-service/api/send-emails/workers-api/`
- Cloudflare Email Routing legacy Workers API: `https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/`
- Cloudflare Workers Rate Limiting API: `https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/`
- Cloudflare Workers pricing: `https://developers.cloudflare.com/workers/platform/pricing/`
- Cloudflare Workers Node.js compatibility: `https://developers.cloudflare.com/workers/runtime-apis/nodejs/`
- Cloudflare Workers `node:crypto`: `https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/`
- Cloudflare Workers Vitest integration: `https://developers.cloudflare.com/workers/testing/vitest-integration/`
- Cloudflare Turnstile server-side validation: `https://developers.cloudflare.com/turnstile/get-started/server-side-validation/`
- Cloudflare Deploy to Cloudflare buttons: `https://developers.cloudflare.com/workers/platform/deploy-buttons/`
- npm `npx` docs: `https://docs.npmjs.com/cli/v8/commands/npx`
- npm `npm exec` docs: `https://docs.npmjs.com/cli/v8/commands/npm-exec/`
- MDN Set-Cookie reference: `https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie`
- OWASP Password Storage Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html`
- OWASP Authentication Cheat Sheet: `https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html`
- Hono npm package: `https://www.npmjs.com/package/hono`
- TypeScript 6.0 release notes: `https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/`

---

## 35. Public README Draft

Use this as the repo README starting point.

~~~md
# Cloudflare Auth

Self-deployed auth for Cloudflare Workers, D1, and email-based login.

Cloudflare Auth is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Cloudflare.

Cloudflare Auth gives small Cloudflare apps email/password auth, username/password auth, magic links, email verification, password reset, secure cookie sessions, D1 migrations, local dev email links, and route protection without a hosted auth service.

## What you get

- Email/password signup and login
- Optional username/password login
- Magic links
- Email verification
- Password reset
- Secure HTTP-only session cookies
- D1-backed users, sessions, and tokens
- Local dev emails printed to your terminal
- Hono and plain Worker adapters
- Browser client SDK
- CLI for init, migrations, diagnostics, code generation, account recovery, cleanup, and deploy

## Quickstart

```bash
npm create cloudflare-auth@latest my-app
cd my-app
npm run dev
```

Open the local URL printed by Wrangler. In development, auth emails are printed to your terminal, so you do not need to configure an email provider just to try the project.

## Add to an existing Hono app

```bash
npx cf-auth@latest init
npx cf-auth@latest migrate --local
npm run dev
```

Mount the auth routes:

```ts
import { Hono } from "hono";
import { createAuthRoutes, getAuthUser, requireUser, requireVerifiedUser } from "@cf-auth/hono";
import authConfig from "./auth.config";

const app = new Hono();

app.route(authConfig.basePath, createAuthRoutes(authConfig));

app.get("/api/me", requireUser(), async (c) => {
  const user = getAuthUser(c);
  return c.json({ user });
});

export default app;
```

## Use the browser client

```ts
import { createAuthClient } from "@cf-auth/client";

const auth = createAuthClient({ basePath: "/auth" });

await auth.signUp({ email, password });
await auth.signInWithPassword({ identifier: email, password });
await auth.signInWithMagicLink({ email, redirectTo: "/dashboard" });
const { user } = await auth.getUser();
await auth.signOut();
```

## Local development

In local development, Cloudflare Auth prints email links to your terminal:

```text
[cf-auth dev email]
Magic link for person@example.com:
http://localhost:8787/auth/magic-link/verify?token=...
```

Magic links and verification links open a confirmation page first. The token is consumed only when the user confirms, which prevents email link scanners from using one-time links before the user does.

## Deploy

```bash
npx cf-auth@latest doctor --env production
npx cf-auth@latest migrate --remote --env production
npx cf-auth@latest deploy --env production
```

Or:

```bash
npx cf-auth@latest deploy --migrate --env production
```

The CLI uses Wrangler underneath, but the normal workflow is through `cf-auth`.

## Cloudflare Email

Cloudflare Email Service is the default production email adapter when your domain and plan support it. If Cloudflare Email is not available for your project, use a custom email adapter such as Resend, Postmark, or your own sender.

## Security defaults

- Opaque D1-backed sessions, not JWTs
- HTTP-only cookies
- `SameSite=Lax` by default
- Passwords hashed with `scrypt` behind a Worker-safe concurrency guard
- Raw session and email tokens are never stored
- Magic/reset/verification tokens are single-use
- Magic/verification links are consumed by POST confirmation, not GET
- D1 fallback rate limiting, including token-consume endpoints
- Safe redirect allowlist with redirects stored at token creation
- No production links generated from request `Host`
- Built-in reset page avoids leaking reset tokens to third-party scripts

## Supported frameworks

MVP support:

- Hono on Cloudflare Workers
- Plain Cloudflare Workers
- React + Vite frontend with a Worker API example

Other framework examples belong in the roadmap until they are implemented and tested.

## Non-goals

Cloudflare Auth is not a hosted identity provider. It does not include a hosted dashboard, OAuth, SAML, enterprise SSO, organizations, MFA, passkeys, or a centralized user database in v1. See [Non-goals](docs/non-goals.md) for the full v1 exclusion list.

## Docs

- [Quickstart](docs/quickstart.md)
- [Existing Hono app](docs/existing-hono-app.md)
- [Deployment](docs/deployment.md)
- [Cloudflare Email](docs/cloudflare-email.md)
- [Custom email adapter](docs/custom-email-adapter.md)
- [Configuration](docs/configuration.md)
- [API reference](docs/api.md)
- [Security model](docs/security-model.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Non-goals](docs/non-goals.md)

## License

Apache-2.0
~~~

---

## 36. Final Beta Definition of Done

A GitHub repo is ready for public beta when:

- `pnpm install` works from a clean clone.
- `pnpm build` succeeds.
- `pnpm test` succeeds.
- `pnpm lint` succeeds.
- examples build.
- `npm create cloudflare-auth@latest my-app` works, or docs consistently use the scoped CLI fallback new-app command.
- `npx cf-auth@latest init` works, or docs consistently use the scoped fallback command.
- local magic link works without email setup.
- magic-link and email-verification GET routes do not consume tokens.
- D1 rate limiter is implemented and tested, including token-consume endpoints.
- remote deploy works with documented Cloudflare setup.
- README follows section 35.
- `SECURITY.md`, `LICENSE`, and `CONTRIBUTING.md` exist.
- packages can be published with Changesets.
- no known high-severity auth bug is open.
- token parser, repository token-boundary, password reset, redaction, runtime config resolution, Wrangler environment validation, auth-state consistency, and password hashing concurrency tests pass.

---

## 37. Implementation Rationale Footnotes

[^token-storage]: Storing only HMACed token material keeps D1 from becoming a bearer-token database. If D1 rows are exposed, the attacker still needs the root secret to turn stored hashes into usable tokens.

[^password-envelope]: Password hash envelopes make future parameter changes and rehash decisions deterministic. The verifier can read the stored algorithm and parameters instead of assuming a global default that may have changed.

[^stored-redirects]: Redirects are validated and stored when the token is created so the consume step cannot be turned into an open redirect by changing query parameters later.

[^post-consume]: Email security scanners often fetch links automatically. A non-consuming `GET` page plus a user-submitted `POST` keeps one-time links from being spent before the user intentionally confirms.

[^terminal-email]: Terminal email prints raw auth links by design. That is useful for local development and unsafe for deployed preview or production logs, where logs may be retained, aggregated, or visible to more people than the developer running the app.

[^enumeration-timing]: Generic JSON alone does not remove enumeration risk. Different branches can still differ in latency, so sensitive request endpoints need similar work patterns, deferred email sends, and rate limits before account-specific branching.

[^public-origin]: Preview and production links need a configured canonical origin. Request hosts and forwarded host headers can be influenced by routing, preview URLs, proxies, or bad requests, so they are not trusted as email-link sources.

[^cookie-prefix]: Cookie prefixes are browser-enforced contracts. `__Host-` requires HTTPS, `Secure`, `Path=/`, and no `Domain`; local plain HTTP needs an unprefixed cookie so development works without weakening production behavior.

[^cors-csrf]: Credentialed CORS changes the CSRF threat model because browsers attach cookies automatically. Auth routes must own their CORS and origin checks instead of inheriting broad app middleware.

[^pii-hashing]: Rate-limit and event rows are operational security data, not customer-profile data. HMACing emails, IPs, and user agents supports correlation without storing raw PII.

[^route-boundary]: Auth path matching must be boundary-aware because simple prefix checks can accidentally capture unrelated paths such as `/authentication` or create double-mounted paths such as `/auth/auth`.

[^doctor]: The CLI is the main developer experience. `doctor` exists to surface platform and configuration failures before users discover them as confusing runtime auth bugs.

[^body-limit]: Auth endpoints need only small payloads. Early body limits reduce memory pressure and prevent large-body parsing from becoming a cheap denial-of-service path.

[^hash-concurrency]: Password hashing is intentionally expensive. A small per-isolate queue prevents concurrent hash operations from exhausting Worker memory or CPU under bursts.

[^log-redaction]: Auth failures often surface through logs and thrown errors. A shared redactor keeps sensitive values out of terminal output, CI logs, observability tools, and issue reports.

[^runtime-config]: Worker bindings and secrets are runtime values. Separating static config validation from request-time resolution avoids import-time access to unavailable bindings and makes adapter behavior testable.

[^same-site]: Same-origin and same-site deployments are practical defaults for Workers apps. Full cross-site cookie auth requires a complete CSRF design, so v1 keeps that surface closed.

[^non-goals]: The v1 non-goals are intentionally excluded to keep the first release auditable. OAuth, passkeys, MFA, SSO, organizations, and hosted control planes each require their own threat model, recovery flows, and operational support.

[^no-jwt]: Opaque D1-backed sessions make revocation, logout, disabled-user enforcement, and secret rotation straightforward for small self-deployed apps.

[^password-worker-profile]: The password profile is a Worker deployment tradeoff. The default must be strong enough to be useful while fitting typical isolate memory and CPU limits under realistic concurrency.

[^package-boundary]: Explicit exports and runtime-specific package boundaries prevent browser bundles from accidentally importing Worker, Node, or CLI code.

[^token-format]: Dot-delimited tokens avoid ambiguity because `kid` and base64url random values may contain underscores. A strict parser makes token handling deterministic.

[^json-valid]: Metadata columns are used as extension points. Valid JSON constraints prevent malformed metadata from breaking future queries, migrations, or tooling.

[^active-token-policy]: Invalidating previous active email tokens limits confusion and narrows the replay window. `revoked_at` distinguishes intentional invalidation from successful consumption.

[^pepper]: Peppering adds secret lifecycle and rotation complexity. v1 keeps password verification tied to explicit hash envelopes rather than adding another undeclared key ring.

[^canonicalization]: Hashes are only useful for rate limiting and event correlation when the input is stable. Canonical IP and user-agent handling avoids accidental key fragmentation.

[^cookie-clear]: Browsers match cookie deletion by name, path, and domain. Logout must clear the exact deployed cookie shape, including migration cases between host-only and parent-domain cookies.

[^content-type]: Many clients send `application/json; charset=utf-8`. Accepting parameters keeps normal clients working while still rejecting ambiguous or form-based JSON mutations.

[^consume-response]: Magic-link and verification endpoints serve both built-in HTML flows and SDK JSON flows. Explicit response-mode rules avoid redirect surprises for API clients and JSON leakage into browser pages.

[^reset-page]: Password reset tokens are bearer credentials. The built-in reset page keeps the token on a minimal, no-referrer, no-third-party page; custom pages must provide equivalent protection.

[^reset-hash-order]: Password reset confirmation should not spend CPU on random invalid tokens. Cheap token validation before `scrypt` protects capacity, while consuming the token only after hashing succeeds preserves the user’s ability to retry if hashing fails.

[^edge-prefilter]: D1 rate limits are authoritative but still require a D1 hit. Edge prefilters reduce abusive traffic before it reaches D1 while preserving D1 as the source of truth for account-sensitive limits.

[^email-runtime]: Cloudflare bindings are available on `env` during request handling. Passing runtime context into adapters keeps module imports pure and lets adapters work in tests, preview, and production.

[^verified-user]: A valid session and a verified email are different guarantees. Separate helpers let applications protect sensitive routes without making all logged-in routes require verification.

[^admin-recovery]: Small auth systems still need operational recovery. Disable-user and revoke-session helpers provide incident response without introducing a hosted dashboard or impersonation feature.

[^metrics]: Metrics make abuse, delivery failures, and configuration problems visible. Aggregated or HMACed dimensions preserve observability without turning telemetry into raw PII storage.

[^npm-hardening]: Publishing controls are part of the supply-chain security model. Provenance, 2FA, and package ownership checks reduce the chance of accidental or malicious package publication.

[^rate-limit-key-namespace]: Rate-limit keys need both action and subject-type namespaces because the same literal string can validly appear as an IP address, email local-part, or login identifier. Namespacing prevents one limiter from accidentally consuming another limiter’s budget.

[^key-ring-kids]: Key IDs are routing metadata for secret verification. Unique IDs keep token verification deterministic during staged rotation and prevent the current secret from shadowing a previous secret with the same label.

[^host-validation]: Host validation prevents production auth behavior from depending on arbitrary request hosts. It keeps cookie decisions, origin checks, redirects, and link generation tied to configured deployment origins.

[^wrangler-environments]: Wrangler environment bindings and `vars` are not inherited into named environments. Repeating auth bindings per environment avoids deploys that pass local checks but fail or run with the wrong mode remotely.

[^primary-auth-reads]: Auth state must prefer freshness over replica latency. A stale read can accept a session that was just revoked or a token that was just consumed, so auth decisions need primary-consistent reads or write-guarded transactions.

[^token-subject-invariant]: Token rows need exactly one well-defined subject so consume handlers never have to guess whether to load a user, create a user, or reject the token. The schema keeps that invariant close to the stored token state.

[^origin-vs-redirect]: Request origins answer “which browser origin may send credentialed mutations.” Redirect origins answer “where may the user be sent after auth.” Keeping the lists separate prevents a safe post-login destination from automatically becoming a trusted CSRF/CORS origin.

[^scoped-npx]: The `--package` form names the package to install and the binary to run separately. That avoids relying on npm’s package-to-binary inference for a scoped package whose binary name differs from the package basename.

[^d1-migration-fks]: D1 enforces foreign keys by default and runs migrations in an implicit transaction. `PRAGMA defer_foreign_keys` is the migration-safe way to handle temporary ordering issues while still requiring the final schema/data state to satisfy constraints.

[^version-floor]: A published auth library needs a tested lower bound, not only “latest works.” The floor keeps generated projects reproducible and gives `doctor` a concrete standard for version warnings.

[^safe-compare]: Constant-time comparison helpers usually require equal-length buffers. Wrapping the helper keeps malformed or legacy hash envelopes from throwing in ways that could bypass the normal error path.

[^origin-absence]: Some legitimate non-browser clients omit `Origin`, but browser cookie flows should not rely on that absence. The generated v1 config requires origins for unsafe auth-route mutations so CSRF behavior is explicit and testable.

[^cors-vary]: When a response reflects a specific request origin, caches need `Vary: Origin` so one allowed origin’s CORS response is not reused for another origin.

[^redirect-normalization]: Redirect validation is safest when parsing, normalization, storage, and later use share one canonical representation. That prevents alternate encodings or parser differences from changing the destination after approval.

[^response-request-id]: Request IDs let operators connect a user-visible failure to a redacted auth event or log entry without exposing tokens, passwords, secrets, or raw PII.

[^same-origin-logout]: Logout changes server-side session state and clears a credential. Even with an empty body, it is a mutation and should follow the same origin policy as other cookie-authenticated writes.

[^batch-config-branches]: Optional side effects should be absent from the transaction when disabled. Building the statement list from config avoids accidentally revoking sessions, creating sessions, or marking emails verified in a mode that opted out.

[^dev-outbox-memory]: The development outbox is for local feedback and tests. Workers isolates can restart or split, so in-memory messages are not a reliable audit log or delivery queue.

[^email-binding-type]: The adapter boundary should match the Worker binding closely enough to keep Cloudflare Email-specific details out of core auth logic while still exposing useful production errors.

[^turnstile-order]: Turnstile is most useful before expensive or identity-specific work. Validating it early reduces password-hash load and avoids using account lookup behavior as the first bot-filtering step.

[^repo-token-boundary]: Repositories are persistence adapters, not credential issuers. Keeping raw token generation in token services makes it easier to test storage with fixture hashes and prevents accidental raw-token returns from database code.

[^enumeration-safe-signup]: Enumeration-safe signup cannot both hide duplicates and create an immediate session, because a cookie on only the new-account branch reveals the branch. Requiring verification keeps the response uniform while preserving a usable account-activation path. Username-required signup is excluded from this mode because duplicate username errors would otherwise become a second enumeration channel.

[^jit-email-display]: Magic-link JIT signup tokens store a normalized email subject instead of a display email. This keeps the token subject invariant simple and avoids adding raw email display data to token metadata solely for casing preservation.

[^build-tool]: A single build tool reduces package-boundary drift and makes generated declaration output easier to verify across the monorepo. tsup is sufficient for ESM-first packages that emit JavaScript and `.d.ts` files without framework-specific build steps.

[^secret-cli-input]: Command-line arguments are commonly stored in shell history and can be visible to local process inspection. Reading previous secrets from stdin or a named environment variable avoids teaching operators to paste long-lived credentials directly into command invocations.
