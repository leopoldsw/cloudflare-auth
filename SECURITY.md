# Security Policy

Cloudflare Auth is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Cloudflare.

## Supported Versions

Pre-1.0 releases receive security fixes on the latest prerelease line only. After 1.0, supported versions are listed in release notes and this file.

## Reporting A Vulnerability

Report suspected vulnerabilities privately by opening a GitHub security advisory in this repository or by emailing the maintainer security contact published in the repository metadata.

Do not include raw session cookies, raw magic-link tokens, password-reset tokens, production secrets, full user databases, raw IP addresses, or raw user agents in reports. Redact or replace them with synthetic examples.

## Expected Response Window

Maintainers aim to acknowledge high or critical auth security reports within 3 business days and provide a remediation plan or status update within 10 business days.

## Maintainer Operational Checks

Release maintainers should keep GitHub secret scanning and push protection
enabled where the repository host supports them. The release workflow runs
`pnpm audit --audit-level high` as advisory evidence only; dependency review,
CodeQL, security regression tests, release tracker review, and the 1.0 security
decision remain the release gates.

## Scope

In scope:

- token storage and consumption
- session cookies
- password hashing and reset flows
- redirect validation
- CSRF and CORS behavior
- D1 repository invariants
- CLI secret handling

Out of scope:

- denial-of-service reports that require no authentication and no project-specific weakness
- social engineering
- vulnerabilities in applications that misuse the library contrary to documented requirements
