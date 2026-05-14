# API

Auth routes are mounted under `basePath`, normally `/auth`. All examples below
use the default base path.

JSON responses use this error shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "Invalid JSON body"
  }
}
```

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
minimal page with `Referrer-Policy: no-referrer` and no third-party assets. A
custom reset page must provide equivalent protection:

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
await auth.signOut();
await auth.getUser();
await auth.requestEmailVerification({ email, redirectTo: "/dashboard" });
await auth.requestPasswordReset({ email, afterResetRedirectTo: "/login" });
await auth.resetPassword({ token, password });
```

The client sends `credentials: "include"` by default and throws `AuthClientError` with `code`, `message`, and `status`.

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

Hono routes use the adapter middleware:

```ts
import { getAuthUser, requireUser } from "@cf-auth/hono";

app.get("/api/me", requireUser(), (c) => c.json({ user: getAuthUser(c) }));
```

`getAuthUser(c)` returns the same public user object shape as `getUser()`.

## Package Entrypoints

Every package exposes a single root export map entry, `"."`. Subpath imports are
not part of the v1 public API.

| Entrypoint                  | Primary public surface                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-auth`                   | Unscoped CLI shim package with the `cf-auth` binary. The root export exposes `cfAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                                                                                          |
| `@cf-auth/cli`              | CLI implementation package with the `cf-auth` binary. The root export exposes `runCli(args, io)`, `cliPackageName`, and `CliIO`. Command behavior is documented in [CLI Reference](cli.md).                                                                                                                                                                |
| `create-cloudflare-auth`    | Create-package binary `create-cloudflare-auth`. The root export exposes `createCloudflareAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                                                                                 |
| `@cf-auth/core`             | Core row and repository contracts, normalization helpers, redirect validation, raw-token generation and parsing, HMAC token hashing, key-ring parsing, password hash profiles and envelopes, cookie serialization, derived rate-limit keys, and derived auth-event hashes.                                                                                 |
| `@cf-auth/worker`           | `defineAuthConfig`, `createAuthHandler`, `getSession`, `getUser`, `requireUser`, `requireVerifiedUser`, `getAuthSessionFromRequest`, `createD1Repositories`, `terminalEmail`, `byEnvironment`, `verifyTurnstileToken`, `cloudflareRateLimitPrefilter`, `redactLogValue`, config types, email adapter types, Turnstile types, and runtime package metadata. |
| `@cf-auth/hono`             | `createAuthRoutes`, `optionalUser`, `requireUser`, `requireVerifiedUser`, `getAuthUser`, and `honoPackageName`.                                                                                                                                                                                                                                            |
| `@cf-auth/client`           | `createAuthClient`, `AuthClientError`, `AuthClientOptions`, `PublicAuthUser`, and `clientPackageName`.                                                                                                                                                                                                                                                     |
| `@cf-auth/email-cloudflare` | `cloudflareEmail`, `defaultMagicLinkTemplate`, `defaultEmailVerificationTemplate`, `defaultPasswordResetTemplate`, Cloudflare Email binding/template option types, and `emailCloudflarePackageName`.                                                                                                                                                       |
| `@cf-auth/testing`          | `createSqliteD1Database`, `applyD1Migrations`, `createMockEmailAdapter`, `MockAuthEmail`, and `testingPackageName`.                                                                                                                                                                                                                                        |

The reviewed release surface is summarized in [Public API Report](api-report.md).
