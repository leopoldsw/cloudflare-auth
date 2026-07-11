# Agent Guide

This repository is a Cloudflare-native authentication library and scaffold.
Treat authentication, release automation, migrations, and secret handling as
security-sensitive code. Prefer root-cause fixes with focused regression tests.

## Supported toolchain

- Node.js `>=22.13.0`
- pnpm `11.1.1` through Corepack
- Wrangler `4.110.0`
- TypeScript `7.0.2`
- Workers compatibility date `2026-07-11` with `nodejs_compat`

Use the exact versions in `scripts/version-matrix.json`. Do not update one
template, example, generated literal, or document without updating the matrix
and its verification tests.

## Start from a fresh clone

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm verify:migrations
pnpm verify:examples
pnpm smoke:wrangler-dev
```

`smoke:wrangler-dev` creates a disposable app, applies local D1 migrations,
starts Wrangler, and exercises the auth surface. It does not require a
Cloudflare account or production email provider.

## Create an application

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
cd my-app
pnpm install
npx --package @cf-auth/cli@latest cf-auth migrate --local
pnpm dev
```

Use `--template worker-basic` for a plain Worker. Re-running `init` is
idempotent: it preserves application source, repairs missing auth
configuration, and keeps a backup before replacing an existing Wrangler
configuration. `init` also writes a self-contained `AGENTS.md` runbook into
the app (never overwriting an existing one). Development email links are
printed by the terminal adapter and may also be viewed at `/auth/dev/emails`.

## Architecture map

| Path                        | Responsibility                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/core`             | Normalization, password/token crypto, cookies, and repository contracts                       |
| `packages/worker`           | D1 repositories, auth routes, sessions, email selection, rate limiting, and Turnstile         |
| `packages/hono`             | Hono routes and config-bound user middleware                                                  |
| `packages/client`           | Browser client with same-origin credentialed requests                                         |
| `packages/email-cloudflare` | Cloudflare Email Service adapter and templates                                                |
| `packages/cli`              | Safe scaffold, provision, doctor, migration, deploy, rotation, cleanup, and recovery commands |
| `packages/testing`          | SQLite-backed D1 and email test helpers                                                       |
| `migrations`                | Canonical append-only D1 schema                                                               |
| `templates` / `examples`    | Runnable Hono, plain Worker, and React client integrations                                    |

The Worker stores opaque session and email-token HMACs in D1. Raw tokens exist
only in cookies or email links. Passwords use versioned scrypt envelopes.
Token consumption and security-sensitive state transitions must remain atomic.

## Runtime configuration

Required bindings and values:

- `AUTH_DB`: D1 binding
- `AUTH_SECRET`: Worker secret in `kid.base64url` form
- `AUTH_ENV`: `development`, `preview`, or `production`
- `AUTH_PUBLIC_ORIGIN`: exact origin; required outside local development

Optional values:

- `AUTH_SECRET_PREVIOUS`: previous key ring during rotation
- `AUTH_EMAIL`: Cloudflare Email Service binding
- `TURNSTILE_SECRET_KEY`: required by the built-in verifier when Turnstile is enabled
- `AUTH_RATE_LIMITER`: optional Cloudflare Rate Limiting binding; D1 remains authoritative

Wrangler named-environment bindings, vars, and secrets are non-inheritable.
Inspect the selected environment, not just the top-level config.

## Production setup

Consumer setup is one command. For automation, export `CLOUDFLARE_ACCOUNT_ID`
and a scoped `CLOUDFLARE_API_TOKEN`; see `docs/cloudflare-permissions.md`.

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production
```

`setup` composes provision, remote migrations, missing-secret creation,
doctor, deploy, and deployed-endpoint verification. It is idempotent, never
prompts, and never rotates an existing secret. Automation converges on the
report loop in `docs/automation.md`: run `setup --report --env <name>`,
execute each failed step's `fix` verbatim, and hand the human-only steps in
`docs/manual-steps.md` to an operator. Run `setup --dry-run` first in
unfamiliar accounts. Scaffolded apps carry their own `AGENTS.md` runbook with
the same contract.

The granular sequence remains documented in `docs/deployment.md` for
debugging individual stages. When running it manually, migrate a fresh D1
database before the first `rotate-secret --apply`: Wrangler secret updates
create and deploy a Worker version immediately.

Cloudflare Email sender/domain onboarding and its DNS readiness are external
control-plane steps. The terminal adapter is deliberately rejected in preview
and production.

## Validation ladder

Start narrow, then run the full gates:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:workers
pnpm build
pnpm package:check
pnpm version-matrix:check
pnpm verify:migrations
pnpm verify:examples
pnpm verify:deploy-template
pnpm verify:docs-coverage
pnpm verify:security-docs
pnpm audit --audit-level high
```

For adoption changes also run:

```bash
pnpm smoke:wrangler-dev
CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs
```

Production smoke mutates a real dedicated Worker and D1 database. Run it only
with `CF_AUTH_PRODUCTION_SMOKE=1` and the complete fixture variables described
in `docs/deployment.md`.

## Security invariants

- Never log or commit raw passwords, cookies, auth/email tokens, secrets,
  emails, IP addresses, or user agents.
- Preserve generic responses and comparable work for enumeration-safe flows.
- Limit login requests before password hashing; never swallow rate-limit errors.
- Validate the canonical redirect result, not only its pre-normalized spelling.
- Keep issuance replacement and token consumption atomic in D1.
- Use `__Host-` cookies for secure host-only sessions; parent-domain cookie
  mode intentionally trusts sibling subdomains.
- Hono middleware always receives its own explicit auth config.
- Built-in Turnstile checks bind both hostname and endpoint action.
- Do not follow symlinks when the CLI writes secrets or project configuration.
- Remote CLI mutations require one explicit, accessible account and one exact
  `AUTH_DB` binding.

## Common failures

| Symptom                                        | Action                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| D1 binding missing                             | Check the selected named environment and run `cf-auth provision`                 |
| Fresh production doctor reports missing tables | Apply remote migrations, then rerun doctor                                       |
| Secret missing                                 | Run `cf-auth rotate-secret --apply --env <name>`                                 |
| Multiple Cloudflare accounts                   | Set `CLOUDFLARE_ACCOUNT_ID` or `account_id` explicitly                           |
| Terminal email rejected                        | Configure Cloudflare/custom email outside development                            |
| Cookie not set                                 | Confirm exact HTTPS public origin, host, prefix, and Domain policy               |
| Turnstile mismatch                             | Render the endpoint action documented in `docs/turnstile.md` and verify hostname |
| Migration status disagrees                     | Check the selected binding's `migrations_dir`                                    |
| Existing app has `/auth/auth`                  | Mount routes once at `authConfig.basePath`                                       |

More detail lives in `docs/troubleshooting.md`, `docs/configuration.md`,
`docs/migrations.md`, and `docs/upgrade-guide.md`.
