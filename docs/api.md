# API

Auth routes are mounted under `basePath`, normally `/auth`. All examples below
use the default base path.

JSON responses use this error shape:

```json
{
  "requestId": "req_...",
  "error": {
    "code": "validation_failed",
    "message": "Invalid JSON body"
  }
}
```

`requestId` is included when the runtime can derive one from `CF-Ray` or a
generated request identifier.

Mutation endpoints require a trusted `Origin` header outside local development.
JSON request bodies should use `Content-Type: application/json`; built-in token
confirmation forms submit `application/x-www-form-urlencoded`.

## HTTP Endpoints

| Endpoint                                | Body                               | Success response                                                                  | Notes                                                                                                          |
| --------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `POST /auth/signup`                     | `{ email, password, username? }`   | `{ user }` with session cookie, or `{ ok: true }` for enumeration-safe signup     | Returns `404 not_found` when `signup.enabled` is false.                                                        |
| `POST /auth/login`                      | `{ identifier, password }`         | `{ user }` with session cookie                                                    | `identifier` can be email or username when the corresponding login mode is enabled.                            |
| `POST /auth/logout`                     | none                               | `{ ok: true }` plus a cleared session cookie                                      | Succeeds even when no session is present.                                                                      |
| `GET /auth/user`                        | none                               | `{ user }` or `{ user: null }`                                                    | Returns `null` when the session is absent, revoked, expired, disabled, or hidden by verified-email policy.     |
| `POST /auth/magic-link/request`         | `{ email, redirectTo? }`           | `{ ok: true }`                                                                    | Always uses the generic success response and defers email work.                                                |
| `GET /auth/magic-link/verify?token=...` | none                               | HTML confirmation form                                                            | Parses token shape only; it does not consume the token.                                                        |
| `POST /auth/magic-link/consume`         | `{ token }`                        | `{ user, redirectTo }` with session cookie, or `303` redirect for form requests   | Invalid, expired, replayed, or disabled-user tokens return `400 invalid_token`.                                |
| `POST /auth/email/verify/request`       | `{ email, redirectTo? }`           | `{ ok: true }`                                                                    | Always uses the generic success response and defers email work.                                                |
| `GET /auth/email/verify?token=...`      | none                               | HTML confirmation form                                                            | Parses token shape only; it does not consume the token.                                                        |
| `POST /auth/email/verify/consume`       | `{ token }`                        | `{ user, redirectTo }`, optionally with session cookie, or `303` for form request | Session creation depends on `emailVerification.createSessionAfterVerification`.                                |
| `POST /auth/password/reset/request`     | `{ email, afterResetRedirectTo? }` | `{ ok: true }`                                                                    | Always uses the generic success response and defers email work.                                                |
| `GET /auth/password/reset?token=...`    | none                               | HTML password reset form                                                          | Parses token shape only; it does not consume the token.                                                        |
| `POST /auth/password/reset/confirm`     | `{ token, password }`              | `{ user, redirectTo }`, optionally with session cookie, or `303` for form request | Revokes existing sessions by default. Session creation depends on `passwordReset.createSessionAfterReset`.     |
| `GET /auth/dev/emails`                  | none                               | `{ emails }`                                                                      | Development-only terminal-email outbox; returns `404 not_found` outside development or without outbox support. |

Turnstile-protected endpoints also accept `turnstileToken` in the request body.
Feature-disabled endpoints return `404 not_found` and perform no auth side
effects.

## Custom Password Reset Pages

The built-in `GET /auth/password/reset?token=...` page keeps the token on a
minimal page with `Referrer-Policy: no-referrer`, no third-party assets, and a
same-page history scrubber that removes the token from the current browser
history entry. A custom reset page must provide equivalent protection:

- strip the token from the browser URL immediately after loading
- set `Referrer-Policy: no-referrer`
- avoid third-party scripts, images, analytics, and external styles while the
  token is present
- submit the raw token only to `POST /auth/password/reset/confirm`

The public user object is:

```ts
interface PublicAuthUser {
  id: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  createdAt: number;
}
```

## Browser Client

```ts
import { createAuthClient } from "@cf-auth/client";

const auth = createAuthClient({ basePath: "/auth" });

await auth.signUp({ email, username, password });
await auth.signInWithPassword({ identifier, password });
await auth.signInWithMagicLink({ email, redirectTo: "/dashboard" });
await auth.consumeMagicLink({ token });
await auth.signOut();
await auth.getUser();
await auth.requestEmailVerification({ email, redirectTo: "/dashboard" });
await auth.verifyEmail({ token });
await auth.requestPasswordReset({ email, afterResetRedirectTo: "/login" });
await auth.resetPassword({ token, password });
```

Mutation methods accept an optional `turnstileToken` for Turnstile-protected
endpoints. The client sends `credentials: "include"` by default and throws
`AuthClientError` with `code`, `message`, and `status`.

## Server Helpers

Plain Worker helpers accept `(request, env, ctx, config)`.

```ts
import { getUser, requireVerifiedUser } from "@cf-auth/worker";

const user = await getUser(request, env, ctx, authConfig);
const verifiedUser = await requireVerifiedUser(request, env, ctx, authConfig);
if (verifiedUser instanceof Response) return verifiedUser;
```

`getUser()` returns the public user object or `null`. `requireUser()` returns a
public user object or a `401` JSON `Response`; `requireVerifiedUser()` also
returns a `403 email_verification_required` response for unverified users.
`getSession()` is a server-only helper that returns the full session and
database user row, including internal fields. `getUser()`, `getSession()`, and
`requireUser()` honor `session.requireVerifiedEmail`; `requireVerifiedUser()`
can still distinguish an unverified session from a missing session.
`getAuthSessionFromRequest()` is the lower-level raw session helper used by
adapters.

## Scheduled Cleanup Helper

`cleanCfAuth({ env, config, now?, retention? })` deletes expired or closed auth
rows through the configured D1 binding and returns the number of changed rows:

```ts
import { cleanCfAuth } from "@cf-auth/worker";

const result = await cleanCfAuth({ env, config: authConfig });
```

Default retention windows match `cf-auth clean`: seven days for expired or
revoked sessions, seven days for expired, used, or revoked verification tokens,
one day for expired rate-limit rows, and 90 days for auth events. Custom
retention values and a custom `now` timestamp must be non-negative integer
millisecond values; invalid values are rejected before any delete statements run.

Hono routes use the adapter middleware:

```ts
import { getAuthUser, requireUser } from "@cf-auth/hono";

app.get("/api/me", requireUser(), (c) => c.json({ user: getAuthUser(c) }));
```

`getAuthUser(c)` returns the same public user object shape as `getUser()`.

## Package Entrypoints

Every package exposes a single root export map entry, `"."`. Subpath imports are
not part of the v1 public API.

| Entrypoint                  | Primary public surface                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-auth`                   | Reserved private unscoped CLI shim package with the `cf-auth` binary. It is published only after npm ownership is confirmed. The root export exposes `cfAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                                                           |
| `@cf-auth/cli`              | CLI implementation package with the `cf-auth` binary. The root export exposes `runCli(args, io)`, `cliPackageName`, and `CliIO`. Command behavior is documented in [CLI Reference](cli.md).                                                                                                                                                                                                         |
| `create-cloudflare-auth`    | Reserved private create-package binary `create-cloudflare-auth`. It is published only after npm ownership is confirmed. The root export exposes `createCloudflareAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                                                  |
| `@cf-auth/core`             | Core row and repository contracts plus `normalizeEmail`, `validateRedirectTarget`, `parseAuthKeyRing`, `hashPassword`, `resolveSessionCookie`, `redactLogValue`, token helpers, password hash profiles and envelopes, cookie serialization, derived rate-limit keys, derived auth-event hashes, and runtime package metadata.                                                                       |
| `@cf-auth/worker`           | `defineAuthConfig`, `createAuthHandler`, `getSession`, `getUser`, `requireUser`, `requireVerifiedUser`, `getAuthSessionFromRequest`, `createD1Repositories`, `cleanCfAuth`, `terminalEmail`, `byEnvironment`, `verifyTurnstileToken`, `turnstileEndpointNames`, `cloudflareRateLimitPrefilter`, `redactLogValue`, config types, email adapter types, Turnstile types, and runtime package metadata. |
| `@cf-auth/hono`             | `createAuthRoutes`, `optionalUser`, `requireUser`, `requireVerifiedUser`, `getAuthUser`, and `honoPackageName`.                                                                                                                                                                                                                                                                                     |
| `@cf-auth/client`           | `createAuthClient`, `AuthClientError`, `AuthClientOptions`, `PublicAuthUser`, `TurnstileClientInput`, and `clientPackageName`.                                                                                                                                                                                                                                                                      |
| `@cf-auth/email-cloudflare` | `cloudflareEmail`, `defaultMagicLinkTemplate`, `defaultEmailVerificationTemplate`, `defaultPasswordResetTemplate`, Cloudflare Email binding/template option types, and `emailCloudflarePackageName`.                                                                                                                                                                                                |
| `@cf-auth/testing`          | `createSqliteD1Database`, `applyD1Migrations`, `createMockEmailAdapter`, `MockAuthEmail`, and `testingPackageName`.                                                                                                                                                                                                                                                                                 |

The reviewed release surface is summarized in [Public API Report](api-report.md).
