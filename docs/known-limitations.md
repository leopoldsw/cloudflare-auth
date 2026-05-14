# Known Limitations

Cloudflare Auth v1 is intentionally narrow.

- Hono and plain Workers are the only supported server adapters.
- D1 is the only supported database.
- Sessions are opaque D1-backed cookies; JWT sessions are not supported.
- Cross-site credentialed cookie auth with `SameSite=None` is not supported.
- OAuth, SAML, passkeys, MFA, organizations, roles, hosted dashboards, and billing are outside v1.
- Cloudflare Email is optional; terminal email is development-only and rejected outside development.
- The Cloudflare rate-limit binding is a coarse prefilter. D1 remains the authoritative rate limiter for auth decisions.
- Password reset token validation happens before hashing; token consume, password update, session revocation, and optional replacement-session creation are committed in one D1 batch.
- No-argument Hono `requireUser()` stores the latest mounted config in module scope. Pass the config explicitly when multiple auth configurations run in one isolate.

See `docs/non-goals.md` for the full v1 exclusion list.
