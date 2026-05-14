# Existing Hono App

Run:

```bash
npx --package @cf-auth/cli@latest cf-auth init
pnpm install
npx --package @cf-auth/cli@latest cf-auth migrate --local
```

Mount once:

```ts
import { createAuthRoutes } from "@cf-auth/hono";
import authConfig from "./auth.config.js";

app.route(authConfig.basePath, createAuthRoutes(authConfig));
```

Mount the auth routes before broad app-level CORS, cache, or static-file
middleware. Auth routes own their own CORS and origin checks, and they should
not inherit wildcard credentialed CORS behavior from the host app.

When `src/index.ts` already exists, `init` leaves it unchanged and prints the
mount snippet. It does update `package.json` with missing Cloudflare Auth
dependencies and repairs missing auth vars and D1 bindings in the existing
Wrangler config after writing a sibling `.cf-auth-backup` file. Do not commit
that backup file.

Do not mount a router that defines `/auth` internally. `createAuthRoutes()` defines relative routes so the result is `/auth/signup`, not `/auth/auth/signup`.

Protect app routes with the Hono helpers:

```ts
import { getAuthUser, requireUser, requireVerifiedUser } from "@cf-auth/hono";

app.get("/api/me", requireUser(), (c) => c.json({ user: getAuthUser(c) }));

app.post("/api/billing", requireVerifiedUser(), async (c) => {
  const user = getAuthUser(c);
  return c.json({ userId: user?.id });
});
```

`getAuthUser(c)` returns the public user shape, not the raw database user row.
