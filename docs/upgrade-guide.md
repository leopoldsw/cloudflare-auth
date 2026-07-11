# Upgrade Guide

## Before Upgrading

1. Read the release notes for migration files and config changes.
2. Back up the production D1 database.
3. Run `npx --package @cf-auth/cli@latest cf-auth doctor --report --env production` and keep the redacted report with the release record.
4. Apply migrations in a preview environment before production.

## Schema Migrations

Migrations are append-only and tracked in `auth_schema_migrations`. A production upgrade should run:

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --status --remote --env production
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
```

`npx --package @cf-auth/cli@latest cf-auth setup --env production` is also
safe to rerun on upgrades: it is idempotent, applies pending migrations,
verifies the schema, redeploys, and never rotates an existing secret.

Upgrade tests for 1.0 must prove every beta schema version migrates to the 1.0 schema while preserving:

- users
- active sessions
- token invalidation semantics
- `auth_schema_migrations`
- `auth_meta.schema_version`

The checked-in manifest for this gate is
`tests/fixtures/upgrade/beta-schema-versions.json`. It is intentionally empty
before beta packages exist. Once beta packages exist, every beta schema version
must have a fixture listed there before a stable 1.0 release can pass
`pnpm test` and `pnpm release:gates`.

Each fixture directory contains:

- `schema.sql`: a full D1 auth schema/data snapshot at that beta schema version
- `expected.json`: expected post-upgrade counts and schema metadata

`expected.json` records `schemaVersion`, `schemaMigrations`, `users`,
`activeSessions`, and `invalidatedTokens`. The upgrade test loads the beta
snapshot, applies later migrations from `migrations/`, and compares those
values after migration.

## Config Changes

Config changes must be explicit. Do not silently change password hashing parameters, cookie domain behavior, redirect allowlists, request-origin allowlists, or email adapter behavior during an upgrade.

This hardening release has three intentional fail-closed compatibility changes:

- Hono `optionalUser()`, `requireUser()`, and `requireVerifiedUser()` now require
  the auth config as their first argument. Pass the same config used by the
  corresponding `createAuthRoutes(config)` mount.
- A custom secure host-only session-cookie name must start with `__Host-`; a
  custom secure domain-cookie name must start with `__Secure-`. The default
  `cookieName: "auto"` already selects the correct prefix.
- Built-in Turnstile verification now uses `contextBinding: "strict"` by
  default. Render each widget with the documented endpoint action. Use the
  explicit `"disabled"` setting only when another deployment-specific control
  enforces equivalent hostname and action binding.

Applications that provide a custom `AuthRepositories` implementation must also
implement `verificationTokens.replaceActiveVerificationToken()`. The operation
must revoke the matching active token set and insert its replacement in one
atomic database transaction; a sequential revoke-then-insert implementation
does not preserve the single-active-token policy under concurrent requests.

Cross-subdomain session cookies require `session.domain` to use leading-dot
parent-domain syntax such as `.example.com`. Plain hostnames such as
`example.com` must be updated before deploying a release with stricter cookie
validation.

## Rollback

D1 migrations are forward-only. If a release requires rollback, deploy the previous Worker code only when it is compatible with the migrated schema. Otherwise restore from a D1 backup into a new database binding and redeploy with the previous config.
