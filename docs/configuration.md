# Configuration

`defineAuthConfig()` validates static shape, route paths, feature combinations, origins, redirects, and cookie options at module load. Runtime values such as D1 bindings, secrets, public origin from env, email bindings, and execution context are resolved per request.

Important keys:

- `basePath`: mount path, default `/auth`
- `runtime.mode`: `development`, `preview`, `production`, or `from-env`
- `runtime.publicOrigin`: exact origin or `from-env`
- `database.binding`: D1 binding name, default `AUTH_DB`
- `session.cookieName`: `auto` or explicit cookie name
- `session.domain`: optional leading-dot parent domain for cross-subdomain cookies
- `security.allowedRequestOrigins`: request-origin allowlist
- `redirects.allowedOrigins`: post-auth redirect allowlist
- `request.maxBodyBytes`: default `16384`
- `passwordHashing.profile`: default `workers-balanced`; `doctor` benchmarks the configured profile locally
- `email`: use `byEnvironment(...)` to keep terminal email local and Cloudflare/custom adapters in preview and production
- `turnstile.mode`: `disabled`, `optional`, or `required`
- `turnstile.endpoints`: endpoint names that require or accept Turnstile

The stable config surface is tracked in `docs/config-schema.md`.

Request and redirect origin allowlists must contain exact origins only. Paths,
queries, fragments, wildcards, credentials, and trailing slash variants are
rejected during config validation.

Session cookie names must be valid HTTP token names. `session.domain` is only
for explicit cross-subdomain cookies and must look like `.example.com`; plain
hostnames, wildcards, IP addresses, paths, schemes, and trailing-dot domains
are rejected.

`request.maxBodyBytes` must be a positive integer. `doctor` warns when the
configured auth request-body limit is larger than 64 KiB.
