# Security Model

Checklist:

- account enumeration: generic magic-link, reset, and verification request responses
- credential stuffing: D1 rate limits by derived IP and identifier keys
- brute-force login: password login rate limits and dummy verification path
- reset email abuse: request limits and generic response
- magic-link abuse: request and consume limits
- email link scanners: `GET` renders confirmation only, `POST` consumes
- token replay: single-use token rows with `used_at` and `consume_id`
- token leakage: redaction utility for logs, errors, and reports
- open redirects: validate and store redirects at token creation
- CSRF: unsafe method origin validation
- session theft: HTTP-only opaque cookies and HMAC-hashed token storage
- session fixation: runtime-generated session tokens only
- D1 consistency/concurrency: guarded token consume predicates
- email delivery failure: redacted auth events and generic request responses
- secret rotation: current plus previous key-ring parser
- permissive CORS middleware: auth routes own CORS responses
- raw PII in logs/rate-limits/events: HMAC-derived keys and hashes
- bot pressure: optional Turnstile checks before account-specific branching
- edge floods: optional Cloudflare rate-limit binding before D1 counters

Evidence:

- `tests/crypto-password-session.test.ts`: key rings, token envelopes, password hashing, cookies, opaque rate-limit keys
- `tests/routes.test.ts`: confirmation POST flows, redirect validation, origin checks, enumeration-safe responses, JIT magic-link concurrency
- `tests/security-hardening.test.ts`: Turnstile ordering, Cloudflare rate-limit prefiltering, log redaction
- `tests/email.test.ts`: email adapter behavior and development-only terminal email guard
- `tests/repositories.test.ts`: D1 repository predicates and constraints

Known residual risks:

- D1 is the source of truth for rate limits; Cloudflare's rate-limit binding is a coarse prefilter and should not be treated as an account lockout mechanism.
- Password reset confirmation validates the token before hashing the replacement password, but password update, token consume, and session revocation are separate repository operations.
- Hono's no-argument `requireUser()` helper stores the latest mounted config in module scope. Pass the config explicitly when hosting multiple auth configurations in one isolate.
