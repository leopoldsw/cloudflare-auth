# Migrations

Migrations are append-only SQL files in `migrations/`.

Run locally:

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --local
npx --package @cf-auth/cli@latest cf-auth migrate --status --local
```

Run remotely:

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth migrate --status --remote --env production
```

Every migration updates `auth_schema_migrations` and `auth_meta.schema_version`. Future table rewrites that need temporary foreign-key deferral must use `PRAGMA defer_foreign_keys = on`.

## Scheduled Cleanup

Auth rows use millisecond timestamps. Run cleanup from a Cron Trigger,
maintenance Worker, or controlled D1 execute job after you have observability in
place. A scheduled Worker can use the same default retention windows as
`cf-auth clean`: one day for expired rate-limit rows, seven days for expired or
closed sessions and tokens, and 90 days for operational events.

```ts
import { cleanCfAuth } from "@cf-auth/worker";
import authConfig from "./src/auth.config";

interface Env {
  AUTH_DB: D1Database;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(cleanCfAuth({ env, config: authConfig }));
  },
};
```

Keep `auth_events` according to your product's audit-retention policy. If you do purge it, use `created_at` and a documented retention window rather than deleting all rows.

The CLI cleanup wrapper applies the default v1 retention windows:

```bash
npx --package @cf-auth/cli@latest cf-auth clean --dry-run --remote --env production
npx --package @cf-auth/cli@latest cf-auth clean --remote --env production
```
