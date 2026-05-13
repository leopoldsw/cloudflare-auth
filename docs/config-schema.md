# Config Schema

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
- `passwordHashing.profile` defaults to `workers-balanced`
- `turnstile.mode` defaults to `disabled`
- `turnstile.endpoints` defaults to `[]` and unknown endpoint names are rejected

`session.domain` must be a leading-dot parent domain such as `.example.com`.

Breaking config changes require an upgrade-guide entry and public API report update.
