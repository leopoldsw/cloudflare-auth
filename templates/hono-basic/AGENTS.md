# Agent Runbook — Cloudflare Auth

This application embeds Cloudflare Auth: self-deployed email/password,
magic-link, email-verification, and password-reset flows served by this
Worker at `/auth`, with users, sessions, and tokens stored in the `AUTH_DB`
D1 database. This file is the operating contract for coding agents and
automation working in this repository.

## Local development

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --local
npm run dev
```

Expected: auth routes respond under `/auth`, and magic-link, verification,
and reset emails are printed to the terminal in development.

## Production is one command

Use `wrangler login`, or export both values for non-interactive automation:

```bash
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export CLOUDFLARE_API_TOKEN="<scoped-api-token>"
npx --package @cf-auth/cli@latest cf-auth setup --env production
```

`setup` runs in order: provision the D1 database, apply remote migrations,
create `AUTH_SECRET` only if it is missing (it never rotates an existing
secret), run `doctor` checks, deploy the Worker, and verify the deployed
`/auth` endpoints. Every step is idempotent; rerunning `setup` is safe.

If `AUTH_PUBLIC_ORIGIN` is not configured yet, pass it explicitly:

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production --origin https://app.example.com
```

## Convergence loop for automation

```bash
npx --package @cf-auth/cli@latest cf-auth setup --report --env production
```

- Parse the JSON report (`schemas/setup-report.schema.json` in the
  Cloudflare Auth repository). `ok: true` means setup is complete.
- Otherwise execute each failed step's `fix` string exactly as printed.
- If a failure points at a manual step, stop and hand the exact step to a
  human operator. Never automate the Cloudflare dashboard.
- Rerun the report command. Stop after 5 iterations, or when two consecutive
  runs report the same failures, and summarize what remains.

## API token scopes

Minimum permissions for the standard `workers.dev` deployment path:

- Account → Account Settings: Read
- Account → Workers Scripts: Edit
- Account → D1: Edit
- User → User Details: Read
- User → Memberships: Read

Optional: Zone → Workers Routes: Edit and Zone → DNS: Edit for custom
domains; Account → Email Sending: Edit for email automation.

## Human-only steps

Stop and hand these to a human operator; they cannot be automated:

1. Create the scoped API token above (dashboard: My Profile → API Tokens).
   Done when `wrangler whoami` lists the target account.
2. Register a workers.dev subdomain once per account (the first deploy fails
   with a dashboard onboarding URL). Done when rerunning setup deploys.
3. Enable Workers Paid and Cloudflare Email Sending, verify the sender
   domain, and publish its DNS records. Done when production email checks
   pass in `doctor` and a reset email arrives.
4. Create a Turnstile widget and store `TURNSTILE_SECRET_KEY` (only when
   Turnstile is enabled). Done when the remote Turnstile secret check passes.
5. Choose the exact public origin (workers.dev or a custom domain) and keep
   `AUTH_PUBLIC_ORIGIN` matching the origin that serves this Worker.

## Verify a deployment

```bash
npx --package @cf-auth/cli@latest cf-auth doctor --env production
```

`doctor` must exit 0. `setup` already exercises signup, login, and logout
against the deployed origin unless `--skip-verify` is passed.

## Common failures

- D1 binding or database_id missing: rerun
  `npx --package @cf-auth/cli@latest cf-auth setup --env production`.
- AUTH_SECRET missing remotely: rerun setup; it creates missing secrets
  without rotating existing ones.
- Migrations not applied remotely:
  `npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production`.
- Multiple Cloudflare accounts: set `CLOUDFLARE_ACCOUNT_ID` or `account_id`
  in `wrangler.jsonc`.
- Terminal email rejected in production: configure the Cloudflare Email
  binding or a custom email adapter.
- Cookie not set in production: confirm `AUTH_PUBLIC_ORIGIN` is the exact
  https origin that serves this Worker.

## Do not

- Do not print, log, or commit secrets, tokens, cookies, or `.dev.vars`.
- Do not run `rotate-secret --apply` without `--previous-from-env` or
  `--previous-from-stdin` on a live deployment; it invalidates sessions and
  deploys immediately.
- Do not automate the Cloudflare dashboard; hand manual steps to a human.
- Do not edit existing files in `migrations/`; the schema is append-only.
- In an unfamiliar account, run setup with `--dry-run` first and review the
  plan.
