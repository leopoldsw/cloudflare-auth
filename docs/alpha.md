# Private Alpha

Private alpha validates that a developer can start from a clean directory, complete local auth, and deploy to production using only documented commands.

## Package Preflight

Before publishing or sharing any `@cf-auth/cli@alpha` package, maintainers must
confirm package ownership and npm publisher hardening:

```bash
CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership
pnpm check:package-names
```

Do not publish private-alpha packages from placeholder `0.0.0` or
`0.0.0-*` versions, including `0.0.0-alpha.*`, or without redaction-safe
package ownership evidence.

## Local Setup Script

Run from an empty working directory:

```bash
npx --package @cf-auth/cli@alpha cf-auth init my-app --template hono-basic
cd my-app
pnpm install
npx --package @cf-auth/cli@alpha cf-auth migrate --local
npm run dev
```

Success means:

- signup works at `/auth/signup`
- login works at `/auth/login`
- `/auth/user` returns the signed-in user
- terminal email links are printed locally
- no maintainer-supplied shell command was needed outside this document

Record setup time from the first scaffold command until the first successful signup/login.

## Evidence File

Before public beta, copy `docs/alpha-evidence.example.json` to
`docs/alpha-evidence.json` and record only redaction-safe evidence. Do not paste
raw secrets, cookies, auth tokens, emails from doctor reports, IPs, or user
agents, or Cloudflare API tokens into the evidence file. The verifier enforces
the public-beta thresholds:

```bash
CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence
```

## Production Deploy Script

Run from the generated app:

```bash
npx --package @cf-auth/cli@alpha cf-auth setup --report --env production --output setup-report.json
```

`setup` provisions D1, applies remote migrations, creates a missing
`AUTH_SECRET`, runs doctor, deploys, and verifies the deployed endpoints in
one idempotent command. The equivalent granular sequence remains supported:

```bash
npx --package @cf-auth/cli@alpha cf-auth doctor --report --env production
npx --package @cf-auth/cli@alpha cf-auth migrate --remote --env production
npx --package @cf-auth/cli@alpha cf-auth deploy --env production
```

Attach the `setup --report` or `doctor --report` JSON to alpha feedback. The report schemas are checked in at `schemas/setup-report.schema.json` and `schemas/doctor-report.schema.json`; reports omit raw secrets, tokens, cookies, emails, IPs, and user agents.

## Feedback Triage

For every setup or deploy failure, maintainers must classify the outcome before public beta:

- already diagnosed by `doctor`
- fixed by an existing troubleshooting entry
- new troubleshooting entry needed
- CLI diagnostic needed
- code defect
- external Cloudflare account or product setup issue

Public beta is blocked until at least 80% of alpha failures have either a `doctor` diagnostic or a troubleshooting entry with an exact fix.
