# Security Review Decision

Status: pending.

1.0 requires either an external security review or explicit maintainer sign-off to release without one.

## Required Inputs

- final public API report
- final config schema
- security model checklist
- migration and upgrade tests
- dependency review result
- advisory `npm audit --audit-level high` result
- secret scanning and push-protection status
- unresolved high/critical auth security issue review

Stable 1.0 also requires a redaction-safe security release tracker. Copy
`docs/security-release-tracker.example.json` to
`docs/security-release-tracker.json` without raw secrets, tokens, cookies,
emails, IPs, user agents, or Cloudflare API tokens and run:

```bash
CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker
```

The tracker must show the issue and advisory searches used to confirm that no
high/critical auth security issue or advisory remains open.

## Decision Record

Before 1.0, replace this section with one of:

- external review completed, including reviewer, date, scope, and unresolved findings
- maintainer sign-off without external review, including date, rationale, and compensating controls

Do not tag 1.0 while this decision is pending.
