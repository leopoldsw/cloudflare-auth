# Deployment

Production deploys should use a named environment and deterministic account
selection. Interactive users can run `wrangler login`; automation must export
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The least-privilege
token matrix is in [Cloudflare API Permissions](cloudflare-permissions.md).

Use the supported toolchain from [Toolchain](toolchain.md) when deploying
release candidates or reproducing support reports.

## One-Command Production Setup

From the generated application directory:

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production
```

`setup` runs the entire sequence below — provision, remote migrations,
missing-secret creation, doctor, deploy, and deployed-endpoint verification —
as one idempotent, non-interactive command. The first failed step stops the
run and prints exactly one `Next action:` line;
`setup --report --env production` emits redaction-safe JSON matching
`schemas/setup-report.schema.json` where every failed step carries an
executable `fix`. Automation should follow the convergence loop in
[Automation Contract](automation.md); the Cloudflare steps that stay manual
are the numbered runbook in [Manual Cloudflare Setup](manual-steps.md). Pass
`--origin <https-origin>` when `AUTH_PUBLIC_ORIGIN` is not configured yet,
and preview everything with `setup --dry-run --env production` in unfamiliar
accounts.

## Step-By-Step Escape Hatch

The granular sequence behind `setup`, for operators who want to run or debug
each stage individually. From the generated application directory:

```bash
# 1. Ensure the selected D1 database exists and patch its real ID.
npx --package @cf-auth/cli@latest cf-auth provision --env production

# 2. Apply the append-only schema before any Worker version goes live.
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production

# 3. Create the first Worker auth secret without printing it.
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production

# 4. Validate account, bindings, secrets, email policy, hashing, and schema.
npx --package @cf-auth/cli@latest cf-auth doctor --env production

# 5. Deploy the Worker.
npx --package @cf-auth/cli@latest cf-auth deploy --env production
```

`provision` lists D1 databases first, reuses an exact-name match, and only
creates a database when none exists. It writes a sibling
`.cf-auth-backup` before safely replacing Wrangler configuration. Use
`--location <region>` or `--jurisdiction eu|fedramp` only on first creation;
those D1 placement choices cannot be changed by rerunning setup.

[`wrangler secret bulk`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk),
which backs `rotate-secret --apply`, creates and deploys a Worker version
immediately. The fresh-deployment order therefore migrates D1 first, preventing
an auth Worker from becoming reachable against an uninitialized schema. Treat
later rotations as immediate production deployments and use the previous-secret
options below.

Preview every mutation in an unfamiliar account:

```bash
npx --package @cf-auth/cli@latest cf-auth provision --dry-run --env production
npx --package @cf-auth/cli@latest cf-auth migrate --dry-run --remote --env production
npx --package @cf-auth/cli@latest cf-auth deploy --dry-run --env production
```

To preview the exact checks and Wrangler deploy command without changing
Cloudflare state:

```bash
npx --package @cf-auth/cli@latest cf-auth deploy --dry-run --env production
```

For later releases, apply and verify remote migrations immediately before
deployment:

```bash
npx --package @cf-auth/cli@latest cf-auth deploy --migrate --env production
```

For support and release records, emit the redaction-safe report:

```bash
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production --output auth-doctor-report.json
```

Required placeholders:

- `CLOUDFLARE_ACCOUNT_ID` or Wrangler `account_id`: the one account that owns all selected resources
- `AUTH_PUBLIC_ORIGIN`: exact production origin, for example `https://example.com`
- `AUTH_SECRET`: generated with `npx --package @cf-auth/cli@latest cf-auth rotate-secret --print` and stored as a Worker secret
- `TURNSTILE_SECRET_KEY`: stored as a Worker secret when `turnstile.mode` is `required` and no custom verifier is configured
- `AUTH_DB.database_id`: production D1 database ID
- `AUTH_EMAIL`: Cloudflare Email binding when using Cloudflare Email

`doctor --env production` checks remote Worker secret existence with
`wrangler secret list --format json`; it can verify that `AUTH_SECRET` exists,
and, when required, `TURNSTILE_SECRET_KEY` exists, but it cannot read back or
validate secret values.

`doctor` also inspects `src` source files when present. It fails remote deploy
checks when preview/production email config selects terminal email/dev outbox,
when literal request or redirect origin allowlists are invalid, when auth
routes are mounted more than once, or when an obvious `/auth/auth` double prefix
exists.
It also runs the configured password hashing profile benchmark in Wrangler's
local Workers runtime, reports p50/p95 and throughput, and labels production
results as local estimates.

`npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production` generates a new `AUTH_SECRET`
and sends it to Wrangler over stdin in one bulk update. Wrangler creates and
deploys a Worker version for that update; the CLI prints the operation result,
not the generated secret. Provide `--previous-from-env NAME` or
`--previous-from-stdin` when rotating without invalidating existing sessions and
email tokens.

After a successful deploy, the CLI prints the mounted auth endpoints and a
Cloudflare Email/DNS readiness reminder. Treat that reminder as external setup:
Wrangler can verify the binding exists, but sender/domain readiness still lives
in Cloudflare Email configuration.

Deploying or mutating D1 without `--env` fails when named environments exist.
Remote mutations also fail before Wrangler is invoked when account selection is
ambiguous, the configured account is inaccessible, or `AUTH_DB` is missing,
duplicated, incomplete, or still contains a placeholder ID.

## Opt-in Production Smoke

Maintainers can run the real Cloudflare production smoke from a dedicated
fixture account:

```bash
CF_AUTH_PRODUCTION_SMOKE=1 \
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID=... \
CF_AUTH_PRODUCTION_SMOKE_DATABASE_NAME=cf-auth-production-smoke \
CF_AUTH_PRODUCTION_SMOKE_WORKER_NAME=cf-auth-production-smoke \
CF_AUTH_PRODUCTION_SMOKE_ORIGIN=https://example.workers.dev \
pnpm smoke:cloudflare-production
```

Production smoke placeholders:

- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID that owns the smoke Worker and D1 database
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with permission to deploy the smoke Worker, list secrets, and apply D1 migrations
- `CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID`: D1 database ID for the dedicated smoke fixture
- `CF_AUTH_PRODUCTION_SMOKE_DATABASE_NAME`: D1 database name for the dedicated smoke fixture
- `CF_AUTH_PRODUCTION_SMOKE_WORKER_NAME`: Worker name reserved for the production smoke fixture
- `CF_AUTH_PRODUCTION_SMOKE_ORIGIN`: exact HTTPS origin of the deployed smoke Worker, with no path or trailing slash

The script creates a temporary app, runs `doctor --env production`, applies
remote migrations, requires a clean second `doctor --env production`, deploys
with `cf-auth deploy --env production`, and exercises deployed `POST
/auth/signup`, `POST /auth/login`, `POST /auth/logout`, and `GET /auth/user`. Set
`CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG=beta` or a concrete `x.y.z-beta.*`
prerelease version to verify published beta packages instead of local tarballs.

The Deploy to Cloudflare button readiness checklist is tracked in `docs/deploy-to-cloudflare.md`.
