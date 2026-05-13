# Upgrade Guide

## Before Upgrading

1. Read the release notes for migration files and config changes.
2. Back up the production D1 database.
3. Run `npx cf-auth@latest doctor --report --env production` and keep the redacted report with the release record.
4. Apply migrations in a preview environment before production.

## Schema Migrations

Migrations are append-only and tracked in `auth_schema_migrations`. A production upgrade should run:

```bash
npx cf-auth@latest migrate --status --remote --env production
npx cf-auth@latest migrate --remote --env production
```

Upgrade tests for 1.0 must prove every beta schema version migrates to the 1.0 schema while preserving:

- users
- active sessions
- token invalidation semantics
- `auth_schema_migrations`
- `auth_meta.schema_version`

## Config Changes

Config changes must be explicit. Do not silently change password hashing parameters, cookie domain behavior, redirect allowlists, request-origin allowlists, or email adapter behavior during an upgrade.

Cross-subdomain session cookies require `session.domain` to use leading-dot
parent-domain syntax such as `.example.com`. Plain hostnames such as
`example.com` must be updated before deploying a release with stricter cookie
validation.

## Rollback

D1 migrations are forward-only. If a release requires rollback, deploy the previous Worker code only when it is compatible with the migrated schema. Otherwise restore from a D1 backup into a new database binding and redeploy with the previous config.
