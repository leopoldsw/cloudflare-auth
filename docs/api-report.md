# Public API Report

This report is the reviewed v1 public surface. Any breaking change requires an upgrade note.

## Packages

- `cf-auth`: CLI shim exposing the `cf-auth` binary.
- `@cf-auth/cli`: `runCli(args, io)`.
- `create-cloudflare-auth`: delegates to the CLI init flow.
- `@cf-auth/core`: crypto, password, token, cookie, validation, and repository contracts.
- `@cf-auth/worker`: `defineAuthConfig`, `createAuthHandler`, `getAuthSessionFromRequest`, D1 repositories, email adapter types, terminal email, Turnstile verifier, rate-limit prefilter, and log redactor.
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

The report is checked in before 1.0 readiness, but it is not release-approved until the 1.0 release checklist is complete.
