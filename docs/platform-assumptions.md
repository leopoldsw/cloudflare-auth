# Platform Assumptions

Date rechecked: May 15, 2026

These are volatile Cloudflare platform assumptions that affect release
readiness. Recheck this page before public beta and before 1.0, and update
`docs/toolchain.md`, generated templates, examples, and `doctor` guidance when a
platform minimum or binding shape changes.

| Area                      | Current assumption                                                                                                                                      | Official source                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Wrangler                  | Wrangler is the Cloudflare Developer Platform CLI used to manage Worker projects, configuration, development, and deploy commands.                      | [Wrangler docs](https://developers.cloudflare.com/workers/wrangler/)                                                  |
| Wrangler environments     | Named-environment `vars`, secrets, and bindings are non-inheritable; production deploys must repeat auth vars and bindings in the selected environment. | [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)                             |
| D1 migrations             | D1 migrations are managed through Wrangler, use a migrations directory, and record applied migrations in a D1 migrations table by default.              | [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)                                           |
| D1 consistency            | `withSession("first-primary")` starts a D1 session with the first query on the primary database and subsequent sequential consistency.                  | [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#withsession)                           |
| D1 foreign keys           | D1 migration table rewrites that temporarily violate foreign keys should use `PRAGMA defer_foreign_keys`.                                               | [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)                                         |
| Cloudflare Email Service  | Cloudflare Email Service includes outbound transactional Email Sending and remains marked beta.                                                         | [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)                                          |
| Workers Rate Limiting API | The Rate Limiting binding requires Wrangler `4.36.0` or later; simple periods are constrained to `10` or `60` seconds.                                  | [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)                  |
| Node.js compatibility     | Workers need `nodejs_compat` and compatibility date `2024-09-23` or later for current Node.js compatibility behavior.                                   | [Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)                               |
| Node crypto               | `node:crypto` is available with Node.js compatibility, with documented exceptions that do not block HMAC or scrypt usage in this project.               | [Workers node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)                          |
| Workers Vitest            | Cloudflare provides a Workers Vitest integration with a custom pool that runs tests inside the Workers runtime.                                         | [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)                   |
| Turnstile                 | Turnstile requires server-side Siteverify validation; tokens expire after five minutes and are single-use.                                              | [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)   |
| Deploy to Cloudflare      | Deploy to Cloudflare can create a repository, provision supported resources such as D1, configure Workers Builds, and produce previews.                 | [Deploy to Cloudflare changelog](https://developers.cloudflare.com/changelog/2025-04-08-deploy-to-cloudflare-button/) |

## Local Enforcement

- `pnpm version-matrix:check` enforces pinned versions and generated compatibility-date values.
- `pnpm verify:migrations` enforces migration naming, schema-version tracking, and foreign-key deferral rules.
- `pnpm verify:deploy-template` checks deploy-template Wrangler binding shape.
- `pnpm verify:examples` checks example Wrangler config and prevents committed environment secret files.
- `pnpm release:gates` requires this platform-assumptions document before release.
