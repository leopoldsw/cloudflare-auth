# Cloudflare Auth

Cloudflare Auth is an independent open-source authentication kit for Cloudflare Workers applications. It provides self-deployed email/password auth, username login, magic links, email verification, password reset, D1-backed opaque sessions, local terminal email, and adapters for Hono and plain Workers. Developers own the Worker, D1 database, secrets, email configuration, and user data in their own Cloudflare account. This project is not affiliated with, endorsed by, or sponsored by Cloudflare.

## 5-Minute Quickstart

```bash
npm create cloudflare-auth@latest my-app
cd my-app
npm run dev
```

If the unscoped package name is unavailable before publication, use:

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
```

The local template runs auth at `/auth`, stores data in D1, prints development email links to the terminal, and uses an unprefixed local cookie on `http://localhost`.

## Existing Hono App

```bash
npx cf-auth@latest init
npx cf-auth@latest migrate --local
npm run dev
```

The fallback command before unscoped package publication is:

```bash
npx --package @cf-auth/cli@latest cf-auth init
```

Mount the generated routes once:

```ts
app.route(authConfig.basePath, createAuthRoutes(authConfig));
```

## Local Development Email

Development uses the terminal email adapter by default. Magic-link, verification, and reset URLs are printed locally and can optionally appear in the development outbox at `/auth/dev/emails`. Terminal email is rejected in preview and production.

## Deploy To Cloudflare

```bash
npx cf-auth@latest doctor --env production
npx cf-auth@latest migrate --remote --env production
npx cf-auth@latest deploy --env production
```

Use `cf-auth deploy --migrate --env production` when you want the CLI to run migration checks during deployment.

Run `npx cf-auth@latest doctor --report --env production` when you need redaction-safe JSON for support or release records.

## Security Defaults

Cloudflare Auth stores only HMAC-hashed session and email tokens, uses versioned password hash envelopes, validates redirect targets before token creation, consumes magic and verification links only on `POST`, uses D1 rate limits with opaque derived keys, and keeps request-origin and redirect-origin allowlists separate.

Operational event queries are documented in [docs/metrics.md](docs/metrics.md). Event rows use HMACed IP and user-agent values and do not store raw identifiers, tokens, cookies, or passwords.

## Supported Frameworks

The v1 surface supports Hono and plain Cloudflare Workers. The browser client SDK is framework-agnostic.

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for missing D1 bindings, unapplied migrations, secret setup, cookie issues, email binding failures, and package-name fallback commands.

Known v1 limitations are listed in [docs/known-limitations.md](docs/known-limitations.md).

## Non-Goals

OAuth, SAML, passkeys, MFA, organizations, hosted dashboards, hosted auth service, billing, and authorization roles are outside v1. See [docs/non-goals.md](docs/non-goals.md).

## Security Policy

Supported versions and vulnerability reporting instructions live in [SECURITY.md](SECURITY.md).
