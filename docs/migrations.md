# Migrations

Migrations are append-only SQL files in `migrations/`.

Run locally:

```bash
npx cf-auth@latest migrate --local
```

Run remotely:

```bash
npx cf-auth@latest migrate --remote --env production
```

Every migration updates `auth_schema_migrations` and `auth_meta.schema_version`. Future table rewrites that need temporary foreign-key deferral must use `PRAGMA defer_foreign_keys = on`.

## Scheduled Cleanup

Auth rows use millisecond timestamps. Run cleanup from a Cron Trigger, maintenance Worker, or controlled D1 execute job after you have observability in place:

```ts
const now = Date.now();
await env.AUTH_DB.batch([
  env.AUTH_DB.prepare("DELETE FROM rate_limits WHERE reset_at < ?").bind(now),
  env.AUTH_DB.prepare(
    "DELETE FROM verification_tokens WHERE expires_at < ? AND (used_at IS NOT NULL OR revoked_at IS NOT NULL)",
  ).bind(now),
  env.AUTH_DB.prepare(
    "DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)",
  ).bind(now, now - 30 * 24 * 60 * 60 * 1000),
]);
```

Keep `auth_events` according to your product's audit-retention policy. If you do purge it, use `created_at` and a documented retention window rather than deleting all rows.
