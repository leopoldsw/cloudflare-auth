# Deployment

Production deploys should use a named environment.

```bash
npx --package @cf-auth/cli@latest cf-auth doctor --env production
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth deploy --env production
```

To preview the exact checks and Wrangler deploy command without changing
Cloudflare state:

```bash
npx --package @cf-auth/cli@latest cf-auth deploy --dry-run --env production
```

To apply remote migrations immediately before deployment:

```bash
npx --package @cf-auth/cli@latest cf-auth deploy --migrate --env production
```

For support and release records, emit the redaction-safe report:

```bash
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production --output auth-doctor-report.json
```

Required placeholders:

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
and sends it to Wrangler over stdin. It prints the Wrangler operation result,
not the generated secret. Provide `--previous-from-env NAME` or
`--previous-from-stdin` when rotating without invalidating existing sessions and
email tokens.

After a successful deploy, the CLI prints the mounted auth endpoints and a
Cloudflare Email/DNS readiness reminder. Treat that reminder as external setup:
Wrangler can verify the binding exists, but sender/domain readiness still lives
in Cloudflare Email configuration.

Deploying without `--env` fails unless `doctor` proves the top-level Wrangler config is intentionally production-safe.

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

The script creates a temporary app, runs `doctor --env production`, applies
remote migrations, requires a clean second `doctor --env production`, deploys
with `cf-auth deploy --env production`, and exercises deployed signup, login,
`POST /auth/logout`, and `/auth/user`. Set
`CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG=beta` to verify published beta packages
instead of local tarballs.

The Deploy to Cloudflare button readiness checklist is tracked in `docs/deploy-to-cloudflare.md`.
