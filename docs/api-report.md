# Public API Report

Release approval: pending.

This report is the reviewed v1 public surface. Any breaking change requires an upgrade note.

## Packages

- `cf-auth`: reserved private CLI shim exposing the `cf-auth` binary; published only after unscoped npm ownership is confirmed.
- `@cf-auth/cli`: `runCli(args, io)`.
- `create-cloudflare-auth`: reserved private create-package entrypoint; published only after npm ownership is confirmed.
- `@cf-auth/core`: crypto, password, token, cookie, validation, redaction, and repository contracts, including session cookie name/domain validators.
- `@cf-auth/worker`: `defineAuthConfig`, `createAuthHandler`, `getSession`, `getUser`, `requireUser`, `requireVerifiedUser`, `getAuthSessionFromRequest`, D1 repositories, scheduled cleanup helper, email adapter types, `terminalEmail`, `byEnvironment`, Turnstile verifier, rate-limit prefilter, and log redactor.
- `@cf-auth/hono`: `createAuthRoutes`, `getAuthUser`, `optionalUser`, `requireUser`, and `requireVerifiedUser`.
- `@cf-auth/client`: browser client and typed client errors.
- `@cf-auth/email-cloudflare`: Cloudflare Email adapter and default templates.
- `@cf-auth/testing`: SQLite-backed D1 adapter, migration helper, and mock email adapter.

## Commands

- `cf-auth init`
- `cf-auth migrate`
- `cf-auth doctor`
- `cf-auth doctor --report`
- `cf-auth deploy`
- `cf-auth generate`
- `cf-auth clean`
- `cf-auth rotate-secret`
- `cf-auth users disable|enable`
- `cf-auth sessions revoke|list`

## HTTP Endpoints

The endpoint contract is documented in `docs/api.md`. Magic-link, email-verification, and password-reset `GET` pages never consume tokens.

## Stability Notes

The report is checked in before 1.0 readiness, but it is not release-approved until the 1.0 release checklist is complete. Change the release approval line to `release-approved` only after the release review records the approver and date.
