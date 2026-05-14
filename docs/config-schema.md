# Config Schema

Release approval: pending.

`defineAuthConfig()` is the public config entrypoint. Runtime secrets and bindings are resolved per request from the Worker environment.

Stable top-level keys:

- `appName`
- `basePath`
- `runtime`
- `database`
- `session`
- `request`
- `security`
- `passwordHashing`
- `signup`
- `login`
- `magicLink`
- `passwordReset`
- `emailVerification`
- `turnstile`
- `email`
- `redirects`

Stable nested keys:

- `appName`
- `basePath`
- `runtime.mode`
- `runtime.publicOrigin`
- `runtime.trustedHosts`
- `database.binding`
- `session.cookieName`
- `session.maxAgeDays`
- `session.sameSite`
- `session.secure`
- `session.domain`
- `session.requireVerifiedEmail`
- `request.maxBodyBytes`
- `request.requireOriginOnUnsafeMethods`
- `request.enumerationMinResponseMs`
- `request.enumerationJitterMs`
- `security.allowedRequestOrigins`
- `security.allowedPreviewRequestOrigins`
- `passwordHashing.profile`
- `passwordHashing.maxConcurrentHashesPerIsolate`
- `passwordHashing.queueTimeoutMs`
- `signup.enabled`
- `signup.requireEmailVerificationBeforeSession`
- `signup.enumerationSafe`
- `signup.username.enabled`
- `signup.username.required`
- `login.emailPassword`
- `login.usernamePassword`
- `login.magicLink`
- `login.requireVerifiedEmail`
- `magicLink.allowSignups`
- `magicLink.expiresInMinutes`
- `magicLink.activeTokenPolicy`
- `passwordReset.enabled`
- `passwordReset.expiresInMinutes`
- `passwordReset.revokeExistingSessions`
- `passwordReset.createSessionAfterReset`
- `passwordReset.markEmailVerifiedOnReset`
- `passwordReset.activeTokenPolicy`
- `emailVerification.enabled`
- `emailVerification.expiresInHours`
- `emailVerification.createSessionAfterVerification`
- `emailVerification.activeTokenPolicy`
- `turnstile.mode`
- `turnstile.endpoints`
- `turnstile.verify`
- `email`
- `redirects.defaultAfterLogin`
- `redirects.defaultAfterLogout`
- `redirects.defaultAfterEmailVerification`
- `redirects.defaultAfterPasswordReset`
- `redirects.allowedOrigins`
- `redirects.allowedPreviewOrigins`

Environment keys:

- `AUTH_DB`: D1 binding
- `AUTH_SECRET`: current key-ring secret
- `AUTH_SECRET_PREVIOUS`: optional previous key-ring secret list
- `AUTH_ENV`: `development`, `preview`, or `production`
- `AUTH_PUBLIC_ORIGIN`: public origin for generated links
- `TURNSTILE_SECRET_KEY`: optional Turnstile server-side verification secret
- `AUTH_RATE_LIMITER`: optional Cloudflare rate-limit binding
- `AUTH_EMAIL`: optional Cloudflare Email binding used by `@cf-auth/email-cloudflare`

Defaults:

- `session.cookieName` defaults to `auto`
- `session.sameSite` defaults to `lax`
- `session.domain` is unset unless cross-subdomain cookies are explicitly configured
- `request.maxBodyBytes` defaults to `16384`
- `request.enumerationMinResponseMs` defaults to `0`
- `request.enumerationJitterMs` defaults to `0`
- `passwordHashing.profile` defaults to `workers-balanced`
- `passwordHashing.maxConcurrentHashesPerIsolate` defaults to `1`
- `passwordHashing.queueTimeoutMs` defaults to `2000`
- `turnstile.mode` defaults to `disabled`
- `turnstile.endpoints` defaults to `[]` and unknown endpoint names are rejected

`session.domain` must be a leading-dot parent domain such as `.example.com`.

Breaking config changes require an upgrade-guide entry and public API report update. Change the release approval line to `release-approved` only after the 1.0 config review records the approver and date.
