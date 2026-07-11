# Architecture

Cloudflare Auth is embedded in an application's Worker. It is not a hosted
identity service and has no separate control plane. The application owner owns
the Worker, D1 database, secrets, email sender, routes, and user records in one
Cloudflare account.

```text
Browser or API client
        |
        v
Application Worker
  |-- Hono adapter or plain Worker adapter
  |       |
  |       v
  |   @cf-auth/worker route runtime
  |       |-- @cf-auth/core crypto, validation, cookies, contracts
  |       |-- AUTH_DB (D1 users, opaque sessions, tokens, limits, events)
  |       |-- terminal/custom/Cloudflare Email adapter
  |       |-- optional Turnstile Siteverify
  |       '-- optional Cloudflare Rate Limiting prefilter
  |
  '-- application routes protected by config-bound user helpers
```

## Package boundaries

| Package                     | Owns                                                                                                     | Does not own                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `@cf-auth/core`             | Pure normalization, crypto, cookie, and repository contracts                                             | Worker routing or Cloudflare bindings |
| `@cf-auth/worker`           | Config resolution, HTTP flows, D1 repositories, sessions, rate limits, events, terminal email, Turnstile | Framework-specific routing            |
| `@cf-auth/hono`             | Hono route mount and config-bound middleware                                                             | Authentication state or storage       |
| `@cf-auth/client`           | Same-origin browser calls and typed errors                                                               | Token storage or server policy        |
| `@cf-auth/email-cloudflare` | Email Service message creation/templates                                                                 | Sender-domain onboarding              |
| `@cf-auth/cli`              | Scaffold, provision, migrate, diagnose, rotate, deploy, clean, recover                                   | Hidden dashboard state                |
| `@cf-auth/testing`          | SQLite-backed D1 and mock email helpers                                                                  | Production storage                    |

Dependencies flow inward: adapters depend on the Worker runtime; the Worker
runtime depends on core contracts. Core never imports an adapter, framework, or
Cloudflare control-plane client.

## Data model

D1 is the source of truth:

- `users` stores normalized unique identity fields and versioned password hashes
- `sessions` stores only HMAC-hashed opaque tokens, expiry, revocation, and hashed request metadata
- `verification_tokens` stores HMAC-hashed magic, verification, and reset tokens with single-use state
- `rate_limits` stores opaque action-scoped fixed-window keys
- `auth_events` stores redacted operational outcomes and HMAC-derived request metadata
- schema metadata tables make migration state explicit and verifiable

Raw session tokens exist only in an HttpOnly cookie. Raw email tokens exist
only in the generated link. Passwords, raw tokens, cookies, emails, IP
addresses, and user agents are never written to operational logs.

## Request lifecycle

1. The adapter forwards an auth-path request and its real Worker environment.
2. Runtime config resolves the selected mode, exact public origin, D1 binding,
   key ring, cookie policy, email adapter, and optional abuse controls.
3. Unsafe browser methods must pass origin checks before account-specific work.
4. Public abuse controls run before password hashing or token lookup.
5. Repository methods use bound SQL; token consumption and multi-row security
   transitions use one D1 batch.
6. The runtime returns no-store responses and secure cookie headers.
7. Noncritical email/event work uses `ctx.waitUntil` where response timing
   must not reveal account state.

## Deployment model

Generated Wrangler config separates local development from a named production
environment. Named environment vars and bindings are repeated because Wrangler
does not inherit them. `cf-auth provision` owns deterministic D1 discovery and
creation; Wrangler remains the interface for migrations, secrets, local
development, and deploys. `cf-auth setup` composes provision, remote
migrations, missing-secret creation, doctor, deploy, and deployed-endpoint
verification into one idempotent command.

The only expected dashboard work is Cloudflare Email sender/domain onboarding
and its DNS readiness. A Workers route/custom domain and its DNS records are
optional; a `workers.dev` deployment requires no zone configuration.

## Trust boundaries

- Public clients may control auth request bodies, identifiers, redirect
  requests, cookies, and Turnstile responses.
- Email-link possession authorizes only the purpose and subject encoded by its
  HMAC-backed D1 row.
- Parent-domain session cookies intentionally trust sibling subdomains;
  host-only production cookies use the `__Host-` boundary.
- CLI remote mutations trust an explicitly selected Cloudflare account and the
  one `AUTH_DB` binding in the selected environment.
- Release workflows are privileged supply-chain surfaces and must use protected
  refs/environments plus full-SHA action pins.

See [Security Model](security-model.md), [Sessions and Cookies](sessions-and-cookies.md),
and [Migrations](migrations.md) for the corresponding invariants.
