# Known Limitations

Cloudflare Auth v1 is intentionally narrow.

- Hono and plain Workers are the only supported server adapters.
- D1 is the only supported database.
- Sessions are opaque D1-backed cookies; JWT sessions are not supported.
- Cross-site credentialed cookie auth with `SameSite=None` is not supported.
- OAuth/social login, SAML/enterprise SSO, passkeys, MFA, organizations/teams,
  role/permission framework, hosted dashboard, hosted auth service, billing
  integration, admin impersonation, multi-project control plane, and password
  peppering are outside v1.
- Cloudflare Email is optional; terminal email is development-only and rejected outside development.
- The Cloudflare rate-limit binding is a coarse prefilter. D1 remains the authoritative rate limiter for auth decisions.
- Password reset token validation happens before hashing; token consume, password update, session revocation, and optional replacement-session creation are committed in one D1 batch.

See `docs/non-goals.md` for the full v1 exclusion list.
