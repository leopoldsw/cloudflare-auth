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

## Package Entrypoints

Every package exposes a single root export map entry, `"."`. Subpath imports are
not part of the v1 public API.

| Entrypoint                  | Primary public surface                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cf-auth`                   | Unscoped CLI shim package with the `cf-auth` binary. The root export exposes `cfAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                           |
| `@cf-auth/cli`              | CLI implementation package with the `cf-auth` binary. The root export exposes `runCli(args, io)`, `cliPackageName`, and `CliIO`. Command behavior is documented in [CLI Reference](cli.md).                                                                                                 |
| `create-cloudflare-auth`    | Create-package binary `create-cloudflare-auth`. The root export exposes `createCloudflareAuthPackageName` and re-exports `cliPackageName`.                                                                                                                                                  |
| `@cf-auth/core`             | Core row and repository contracts, normalization helpers, redirect validation, raw-token generation and parsing, HMAC token hashing, key-ring parsing, password hash profiles and envelopes, cookie serialization, derived rate-limit keys, and derived auth-event hashes.                  |
| `@cf-auth/worker`           | `defineAuthConfig`, `createAuthHandler`, `getAuthSessionFromRequest`, `createD1Repositories`, `terminalEmail`, `byEnvironment`, `verifyTurnstileToken`, `cloudflareRateLimitPrefilter`, `redactLogValue`, config types, email adapter types, Turnstile types, and runtime package metadata. |
| `@cf-auth/hono`             | `createAuthRoutes`, `optionalUser`, `requireUser`, `requireVerifiedUser`, `getAuthUser`, and `honoPackageName`.                                                                                                                                                                             |
| `@cf-auth/client`           | `createAuthClient`, `AuthClientError`, `AuthClientOptions`, `PublicAuthUser`, and `clientPackageName`.                                                                                                                                                                                      |
| `@cf-auth/email-cloudflare` | `cloudflareEmail`, `defaultMagicLinkTemplate`, `defaultEmailVerificationTemplate`, `defaultPasswordResetTemplate`, Cloudflare Email binding/template option types, and `emailCloudflarePackageName`.                                                                                        |
| `@cf-auth/testing`          | `createSqliteD1Database`, `applyD1Migrations`, `createMockEmailAdapter`, `MockAuthEmail`, and `testingPackageName`.                                                                                                                                                                         |

The reviewed release surface is summarized in [Public API Report](api-report.md).
