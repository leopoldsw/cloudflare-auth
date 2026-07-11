# Cloudflare Auth

Cloudflare Auth is an independent open-source authentication kit for Cloudflare Workers applications. It provides self-deployed email/password auth, username login, magic links, email verification, password reset, D1-backed opaque sessions, local terminal email, and adapters for Hono and plain Workers. Developers own the Worker, D1 database, secrets, email configuration, and user data in their own Cloudflare account. This project is not affiliated with, endorsed by, or sponsored by Cloudflare.

See [docs/architecture.md](docs/architecture.md) for package boundaries, the
request/data lifecycle, deployment model, and trust boundaries.

## 5-Minute Quickstart

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
cd my-app
pnpm install
npx --package @cf-auth/cli@latest cf-auth migrate --local
npm run dev
```

The local template runs auth at `/auth`, stores data in D1, prints development email links to the terminal, and uses an unprefixed local cookie on `http://localhost`.

## Existing Hono App

```bash
npx --package @cf-auth/cli@latest cf-auth init
pnpm install
npx --package @cf-auth/cli@latest cf-auth migrate --local
npm run dev
```

Mount the generated routes once:

```ts
app.route(authConfig.basePath, createAuthRoutes(authConfig));
```

## Local Development Email

Development uses the terminal email adapter by default. Magic-link, verification, and reset URLs are printed locally and can optionally appear in the development outbox at `/auth/dev/emails`. Terminal email is rejected in preview and production.

## Deploy To Cloudflare

`wrangler login` works for an interactive deploy. Automation should export
`CLOUDFLARE_ACCOUNT_ID` and a scoped `CLOUDFLARE_API_TOKEN` using the exact
permissions in [docs/cloudflare-permissions.md](docs/cloudflare-permissions.md).

```bash
npx --package @cf-auth/cli@latest cf-auth provision --env production
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production
npx --package @cf-auth/cli@latest cf-auth doctor --env production
npx --package @cf-auth/cli@latest cf-auth deploy --env production
```

`provision` discovers an existing exact-name D1 database before creating one
and patches the selected binding, so the setup is safe to rerun. Use
`npx --package @cf-auth/cli@latest cf-auth deploy --migrate --env production`
for later migration-and-deploy cycles.

Run `npx --package @cf-auth/cli@latest cf-auth doctor --report --env production` when you need redaction-safe JSON for support or release records.

## Security Defaults

Cloudflare Auth stores only HMAC-hashed session and email tokens, uses versioned password hash envelopes, validates redirect targets before token creation, consumes magic and verification links only on `POST`, uses D1 rate limits with opaque derived keys, and keeps request-origin and redirect-origin allowlists separate.

Operational event queries are documented in [docs/metrics.md](docs/metrics.md). Event rows use HMACed IP and user-agent values and do not store raw identifiers, tokens, cookies, or passwords.

## Supported Frameworks

The v1 surface supports Hono and plain Cloudflare Workers. The browser client SDK is framework-agnostic.

## Troubleshooting

The full command surface is documented in [docs/cli.md](docs/cli.md).

See [docs/troubleshooting.md](docs/troubleshooting.md) for missing D1 bindings, unapplied migrations, secret setup, cookie issues, email binding failures, and package-name fallback commands.

Known v1 limitations are listed in [docs/known-limitations.md](docs/known-limitations.md).

Autonomous coding agents and maintainers should start with
[AGENTS.md](AGENTS.md) for the architecture map, complete validation ladder,
deployment order, security invariants, and common recovery paths.

## Non-Goals

OAuth/social login, SAML/enterprise SSO, passkeys, MFA, organizations/teams, role/permission framework, hosted dashboard, hosted auth service, billing integration, admin impersonation, multi-project control plane, and password peppering are outside v1. See [docs/non-goals.md](docs/non-goals.md).

## Security Policy

Supported versions and vulnerability reporting instructions live in [SECURITY.md](SECURITY.md).
