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
```

Required placeholders:

- `AUTH_PUBLIC_ORIGIN`: exact production origin, for example `https://example.com`
- `AUTH_SECRET`: generated with `cf-auth rotate-secret --print` and stored as a Worker secret
- `AUTH_DB.database_id`: production D1 database ID
- `AUTH_EMAIL`: Cloudflare Email binding when using Cloudflare Email

Deploying without `--env` fails unless `doctor` proves the top-level Wrangler config is intentionally production-safe.

The Deploy to Cloudflare button readiness checklist is tracked in `docs/deploy-to-cloudflare.md`.
