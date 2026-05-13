# Deployment

Production deploys should use a named environment.

```bash
npx cf-auth@latest doctor --env production
npx cf-auth@latest migrate --remote --env production
npx cf-auth@latest deploy --env production
```

To preview the exact checks and Wrangler deploy command without changing
Cloudflare state:

```bash
npx cf-auth@latest deploy --dry-run --env production
```

To apply remote migrations immediately before deployment:

```bash
npx cf-auth@latest deploy --migrate --env production
```

For support and release records, emit the redaction-safe report:

```bash
npx cf-auth@latest doctor --report --env production
npx cf-auth@latest doctor --report --env production --output auth-doctor-report.json
```

Required placeholders:

- `AUTH_PUBLIC_ORIGIN`: exact production origin, for example `https://example.com`
- `AUTH_SECRET`: generated with `cf-auth rotate-secret --print` and stored as a Worker secret
- `TURNSTILE_SECRET_KEY`: stored as a Worker secret when `turnstile.mode` is `required` and no custom verifier is configured
- `AUTH_DB.database_id`: production D1 database ID
- `AUTH_EMAIL`: Cloudflare Email binding when using Cloudflare Email

`doctor --env production` checks remote Worker secret existence with
`wrangler secret list --format json`; it can verify that `AUTH_SECRET` exists,
and, when required, `TURNSTILE_SECRET_KEY` exists, but it cannot read back or
validate secret values.

`doctor` also inspects `src` source files when present. It fails remote deploy
checks for terminal email/dev outbox usage, invalid literal redirect origin
allowlists, duplicate auth route mounts, and obvious `/auth/auth` double
prefixes.

`cf-auth rotate-secret --apply --env production` generates a new `AUTH_SECRET`
and sends it to Wrangler over stdin. It prints the Wrangler operation result,
not the generated secret. Provide `--previous-from-env NAME` or
`--previous-from-stdin` when rotating without invalidating existing sessions and
email tokens.

After a successful deploy, the CLI prints the mounted auth endpoints and a
Cloudflare Email/DNS readiness reminder. Treat that reminder as external setup:
Wrangler can verify the binding exists, but sender/domain readiness still lives
in Cloudflare Email configuration.

Deploying without `--env` fails unless `doctor` proves the top-level Wrangler config is intentionally production-safe.

The Deploy to Cloudflare button readiness checklist is tracked in `docs/deploy-to-cloudflare.md`.
