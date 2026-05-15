# Configuration

`defineAuthConfig()` validates static shape, route paths, feature combinations, origins, redirects, and cookie options at module load. Runtime values such as D1 bindings, secrets, public origin from env, email bindings, and execution context are resolved per request.

Top-level keys:

| Key                 | Default                  | Notes                                                                                                           |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `appName`           | required                 | Used in generated email templates.                                                                              |
| `basePath`          | `/auth`                  | Mount path; must be a safe absolute path.                                                                       |
| `runtime`           | see below                | Runtime mode, public origin, and trusted host settings.                                                         |
| `database`          | see below                | D1 binding settings.                                                                                            |
| `session`           | see below                | Cookie and session policy.                                                                                      |
| `request`           | see below                | Request size and unsafe-method origin policy.                                                                   |
| `security`          | see below                | Browser request-origin allowlists.                                                                              |
| `passwordHashing`   | see below                | Password profile and per-isolate concurrency.                                                                   |
| `signup`            | see below                | Signup behavior and username policy.                                                                            |
| `login`             | see below                | Password and magic-link login behavior.                                                                         |
| `magicLink`         | see below                | Magic-link token policy.                                                                                        |
| `passwordReset`     | see below                | Reset token, session, and verification policy.                                                                  |
| `emailVerification` | see below                | Verification token and session policy.                                                                          |
| `turnstile`         | see below                | Optional Turnstile enforcement.                                                                                 |
| `email`             | terminal adapter locally | Use `byEnvironment(...)` to keep terminal email local and Cloudflare/custom adapters in preview and production. |
| `redirects`         | see below                | Default redirects and redirect-origin allowlists.                                                               |

Runtime and storage:

| Key                    | Default                                | Notes                                                                |
| ---------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| `runtime.mode`         | `from-env`                             | `development`, `preview`, `production`, or `from-env`.               |
| `runtime.publicOrigin` | `from-env`                             | Exact origin or `from-env`.                                          |
| `runtime.trustedHosts` | `["localhost:8787", "127.0.0.1:8787"]` | Extra accepted request hosts for preview/production host validation. |
| `database.binding`     | `AUTH_DB`                              | D1 binding name.                                                     |

`AUTH_PUBLIC_ORIGIN` is required in preview and production. In development,
omitting it is only supported for trusted localhost requests when the active
email adapter is `terminalEmail(...)`; generated projects still set it
explicitly.

Sessions and requests:

| Key                                    | Default | Notes                                                                                              |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `session.cookieName`                   | `auto`  | Uses safe dev/production names automatically unless explicitly set.                                |
| `session.maxAgeDays`                   | `30`    | Session cookie and row lifetime.                                                                   |
| `session.sameSite`                     | `lax`   | `lax` or `strict`; v1 does not support `none`.                                                     |
| `session.secure`                       | `auto`  | Static value is reserved; runtime derives secure mode from origin.                                 |
| `session.domain`                       | unset   | Optional leading-dot parent domain for cross-subdomain cookies.                                    |
| `session.requireVerifiedEmail`         | `false` | Hides sessions from `/auth/user`, `getUser()`, `getSession()`, and `requireUser()` until verified. |
| `request.maxBodyBytes`                 | `16384` | Positive integer byte limit.                                                                       |
| `request.requireOriginOnUnsafeMethods` | `true`  | Requires trusted `Origin` for browser mutations outside local development.                         |
| `request.enumerationMinResponseMs`     | `0`     | Optional minimum response time for magic-link, email-verification, and password-reset requests.    |
| `request.enumerationJitterMs`          | `0`     | Optional random extra delay added to the enumeration minimum.                                      |

Security, hashing, and bot checks:

| Key                                             | Default            | Notes                                               |
| ----------------------------------------------- | ------------------ | --------------------------------------------------- |
| `security.allowedRequestOrigins`                | `[]`               | Extra exact origins allowed for browser mutations.  |
| `security.allowedPreviewRequestOrigins`         | `[]`               | Preview-only request-origin allowlist.              |
| `passwordHashing.profile`                       | `workers-balanced` | `doctor` benchmarks the configured profile locally. |
| `passwordHashing.maxConcurrentHashesPerIsolate` | `1`                | Per-isolate semaphore limit for password hashing.   |
| `passwordHashing.queueTimeoutMs`                | `2000`             | Maximum time a hash waits for the semaphore.        |
| `turnstile.mode`                                | `disabled`         | `disabled`, `optional`, or `required`.              |
| `turnstile.endpoints`                           | `[]`               | Endpoint names that require or accept Turnstile.    |
| `turnstile.verify`                              | built-in verifier  | Optional custom verifier.                           |

Same-origin unsafe browser requests pass origin validation after host
validation. Credentialed CORS response headers are emitted only for origins
listed in `security.allowedRequestOrigins` or, in preview mode,
`security.allowedPreviewRequestOrigins`.

Signup and login:

| Key                                            | Default | Notes                                                                                      |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `signup.enabled`                               | `true`  | Disables `POST /auth/signup` when false.                                                   |
| `signup.requireEmailVerificationBeforeSession` | `false` | Signup returns no session until verification.                                              |
| `signup.enumerationSafe`                       | `false` | Generic signup response; requires email verification before session and optional username. |
| `signup.username.enabled`                      | `true`  | Allows usernames on signup.                                                                |
| `signup.username.required`                     | `false` | Requires username when enabled.                                                            |
| `login.emailPassword`                          | `true`  | Enables email/password login.                                                              |
| `login.usernamePassword`                       | `true`  | Enables username/password login.                                                           |
| `login.magicLink`                              | `true`  | Enables magic-link request and consume routes.                                             |
| `login.requireVerifiedEmail`                   | `false` | Blocks password login for unverified users.                                                |

Email-token flows:

| Key                                                | Default               | Notes                                                                                                     |
| -------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| `magicLink.allowSignups`                           | `false`               | Allows magic-link JIT signup.                                                                             |
| `magicLink.expiresInMinutes`                       | `15`                  | Magic-link token lifetime.                                                                                |
| `magicLink.activeTokenPolicy`                      | `invalidate-previous` | Also supports `allow-multiple-active`.                                                                    |
| `passwordReset.enabled`                            | `true`                | Enables password-reset request and confirm routes.                                                        |
| `passwordReset.expiresInMinutes`                   | `30`                  | Reset token lifetime.                                                                                     |
| `passwordReset.resetPage.mode`                     | `built-in`            | `built-in` sends links to `/auth/password/reset`; `custom` sends links to `passwordReset.resetPage.path`. |
| `passwordReset.resetPage.path`                     | unset                 | Safe app path for custom reset pages, outside `basePath`.                                                 |
| `passwordReset.revokeExistingSessions`             | `true`                | Revokes existing sessions after reset.                                                                    |
| `passwordReset.createSessionAfterReset`            | `false`               | Creates a new session after reset when true.                                                              |
| `passwordReset.markEmailVerifiedOnReset`           | `true`                | Marks email verified after successful reset.                                                              |
| `passwordReset.activeTokenPolicy`                  | `invalidate-previous` | Also supports `allow-multiple-active`.                                                                    |
| `emailVerification.enabled`                        | `true`                | Enables verification request and consume routes.                                                          |
| `emailVerification.expiresInHours`                 | `24`                  | Verification token lifetime.                                                                              |
| `emailVerification.createSessionAfterVerification` | `false`               | Creates a session after verification when true.                                                           |
| `emailVerification.activeTokenPolicy`              | `invalidate-previous` | Also supports `allow-multiple-active`.                                                                    |

Redirects:

| Key                                       | Default | Notes                                             |
| ----------------------------------------- | ------- | ------------------------------------------------- |
| `redirects.defaultAfterLogin`             | `/`     | Relative path used when login redirect is absent. |
| `redirects.defaultAfterLogout`            | `/`     | Relative path reserved for logout flows.          |
| `redirects.defaultAfterEmailVerification` | `/`     | Relative path used by verification consume flow.  |
| `redirects.defaultAfterPasswordReset`     | `/`     | Relative path used by reset confirm flow.         |
| `redirects.allowedOrigins`                | `[]`    | Exact external redirect origins.                  |
| `redirects.allowedPreviewOrigins`         | `[]`    | Preview-only external redirect origins.           |

The stable config surface is tracked in `docs/config-schema.md`.

Request and redirect origin allowlists must contain exact origins only. Paths,
queries, fragments, wildcards, credentials, and trailing slash variants are
rejected during config validation.

`runtime.trustedHosts` entries are exact `host` or `host:port` values. Schemes,
paths, queries, fragments, credentials, wildcards, whitespace, and trailing-dot
hosts are rejected. Ambiguous host spellings such as shortened or zero-padded
IPv4 addresses and zero-padded ports are also rejected; accepted entries are
normalized to lowercase host matching with explicit `:443` default HTTPS port
normalization.

Session cookie names must be valid HTTP token names. `session.domain` is only
for explicit cross-subdomain cookies and must look like `.example.com`; plain
hostnames, wildcards, IP addresses, paths, schemes, and trailing-dot domains
are rejected. All-numeric dotted domains are also rejected because they are
ambiguous with noncanonical IPv4 forms.

`request.maxBodyBytes` must be a positive integer. Enumeration delay values
must be non-negative integers. `doctor` warns when the configured auth
request-body limit is larger than 64 KiB.
