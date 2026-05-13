# Troubleshooting

| Problem                                        | Fix                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npx cf-auth` fails                            | Ensure the `cf-auth` package exists; otherwise use `npx --package @cf-auth/cli@latest cf-auth`.                                  |
| Wrangler unavailable or wrong version          | Run `pnpm install`, `npx wrangler --version`, and rerun `npx cf-auth@latest doctor`.                                             |
| Cloudflare login or account mismatch           | Run `wrangler login`, then set Wrangler `account_id` to the intended authenticated account.                                      |
| Missing D1 binding                             | Run `npx cf-auth@latest init --repair` or add `AUTH_DB` to `wrangler.jsonc`.                                                     |
| Need support diagnostics                       | Run `npx cf-auth@latest doctor --report --env production` and attach the redaction-safe JSON.                                    |
| Migrations not applied                         | Run `npx cf-auth@latest migrate --local` or `npx cf-auth@latest migrate --remote --env production`.                              |
| Schema version mismatch                        | Run migrations and inspect `auth_schema_migrations`.                                                                             |
| Missing `AUTH_SECRET`                          | Run `npx cf-auth@latest rotate-secret --print` locally or `npx cf-auth@latest rotate-secret --apply --env production`.           |
| Remote secret check fails                      | Run `wrangler login`, confirm the Worker environment exists, then rerun `npx cf-auth@latest doctor --env production`.            |
| Missing `TURNSTILE_SECRET_KEY`                 | Run `wrangler secret put TURNSTILE_SECRET_KEY --env production` when Turnstile required mode uses the built-in verifier.         |
| Secret rotation invalidated sessions           | Rotate again with `--previous-from-env NAME` or `--previous-from-stdin` when the old secret is available.                        |
| Cloudflare Email binding missing               | Add the `AUTH_EMAIL` send_email binding or switch to terminal/custom email.                                                      |
| Terminal email reported in production          | Use `byEnvironment(...)` so only development selects `terminalEmail`, and preview/production select Cloudflare/custom email.     |
| Sender/domain not ready                        | Follow `docs/cloudflare-email.md`.                                                                                               |
| Cookie not set locally                         | Ensure the dev cookie is not `__Host-` on plain HTTP.                                                                            |
| Cookie not set in production                   | Check HTTPS, `Secure`, `Path=/`, and either host-only `__Host-` with no `Domain` or cross-subdomain `__Secure-` with `Domain`.   |
| Cross-subdomain cookie rejected                | Set `session.domain` to a leading-dot parent such as `.example.com`; do not include schemes, wildcards, paths, or IP addresses.  |
| Cookie not sent                                | Check same-origin mode, SameSite, CORS, and fetch credentials.                                                                   |
| Magic link opens but does not log in           | Submit the confirmation form; `GET` does not consume tokens.                                                                     |
| Magic link redirect rejected                   | Add the origin/path to the redirect allowlist, not the request-origin allowlist.                                                 |
| Redirect origin rejected by `doctor`           | Use exact origins like `https://example.com`; omit paths, queries, fragments, wildcards, credentials, and trailing `/`.          |
| Request origin rejected by `doctor`            | Use exact browser origins like `https://app.example.com`; do not reuse redirect URLs with paths.                                 |
| Missing-Origin browser mutations allowed       | Set `request.requireOriginOnUnsafeMethods` to `true` for preview and production cookie auth.                                     |
| Request body limit warning                     | Keep `request.maxBodyBytes` at or below 64 KiB unless a documented integration needs more.                                       |
| Auth route reported as `/auth/auth`            | Mount `createAuthRoutes(authConfig)` once at `authConfig.basePath` or use a single `createAuthHandler(authConfig)`.              |
| Local dev behaves like production              | Set top-level Wrangler `vars.AUTH_ENV` to `development`.                                                                         |
| Deploy uses development settings               | Run `npx cf-auth@latest doctor --env production`; named environments must repeat vars and bindings.                              |
| Password hashing timeout                       | Run `pnpm benchmark:password -- --profile workers-balanced`, reduce the profile explicitly, and inspect semaphore queue metrics. |
| Reset email says OK but no email arrives       | Check email adapter logs and `email_send_failed` auth events.                                                                    |
| JSON request returns `415`                     | Send `Content-Type: application/json`; charset parameters are allowed.                                                           |
| Cross-site frontend cannot stay logged in      | Use same-origin or explicit same-site cross-origin mode; v1 does not support `SameSite=None`.                                    |
| Reset token appears in analytics/referrer logs | Use the built-in reset page or strip the token before loading app code.                                                          |
