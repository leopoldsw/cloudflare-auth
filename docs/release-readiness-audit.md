# Release Readiness Audit

Date: May 15, 2026

This audit maps `cloudflare_auth_implementation_plan.md` to concrete repo
evidence. It is intentionally not a release approval. Maintainers must replace
the pending evidence and signoff files before public beta or 1.0.

## Objective

Ship a polished open-source Cloudflare Auth repo that can be installed, tested,
deployed, consumed as packages, and released only after package ownership,
alpha/beta, deploy-button, and security-review evidence is recorded.

## Current Local Evidence

The local implementation and verifier surface is present for the plan stages:

| Plan area                                         | Evidence                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 0 docs and project identity                 | Root docs, license, security policy, package naming decision, and non-goals are checked in. Public quickstarts use the scoped CLI fallback until package ownership is proven.         |
| Stage 1 tooling                                   | Root scripts cover format, lint, typecheck, tests, build, package checks, version matrix, release gates, smoke tests, and publish dry-run.                                            |
| Stages 2-4 D1, crypto, sessions, and HTTP runtime | Migrations, repository contracts, hashed session/token storage, password envelopes, auth routes, CORS/origin checks, token confirmation pages, and route tests are checked in.        |
| Stages 5-6 email, Hono, Worker, and client SDK    | Terminal, mock, Cloudflare Email, Hono adapter, plain Worker helpers, verified-user helpers, and browser client package are checked in and documented.                                |
| Stage 7 CLI                                       | `init`, `migrate`, `doctor`, `deploy`, `generate`, `clean`, `rotate-secret`, user/session recovery helpers, Wrangler wrapping, and `doctor --report` are implemented with tests.      |
| Stages 8-9 examples, docs, and security hardening | Examples, deployment template verifier, docs coverage verifier, Turnstile, Cloudflare Rate Limiting prefilter, cleanup, redaction, security docs, and hardening tests are checked in. |
| Stages 10-12 release gates                        | Evidence schemas, verifier scripts, opt-in smoke workflows, release workflow gates, package-name checks, API/config approval gates, and security tracker verifier are checked in.     |

Recent local verification has passed for:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:workers`
- `pnpm build`
- `pnpm package:check`
- `pnpm version-matrix:check`
- `pnpm verify:docs-coverage`
- `pnpm verify:security-docs`
- `pnpm verify:migrations`
- `pnpm verify:deploy-template`
- `pnpm verify:examples`
- `pnpm release:gates`
- `pnpm audit --audit-level high`
- `pnpm smoke:wrangler-dev`
- `CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs`
- `pnpm benchmark:password`
- `pnpm publish:dry-run`

## Blocking Evidence

These blockers require maintainer, npm, GitHub, or Cloudflare evidence and must
not be fabricated in the repo:

| Gate                          | Current failing command or file                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Private alpha evidence        | `CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence` fails until `docs/alpha-evidence.json` exists and passes.                                                                    |
| Public beta evidence          | `CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence` fails until `docs/beta-evidence.json` exists and passes.                                                                       |
| Deploy to Cloudflare evidence | `CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence` fails until `docs/deploy-button-evidence.json` exists and passes.                                            |
| Package ownership             | `CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership` and `pnpm check:package-names` fail until `docs/package-ownership.json` records controlled package names and versions. |
| Security release tracker      | `CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker` fails until `docs/security-release-tracker.json` exists and passes.                                                      |
| API approval                  | `docs/api-report.md` has `Release approval: pending.`                                                                                                                                      |
| Config schema approval        | `docs/config-schema.md` has `Release approval: pending.`                                                                                                                                   |
| Security review decision      | `docs/decisions/security-review.md` has `Status: pending.`                                                                                                                                 |
| Published package versions    | Workspace packages remain at private placeholder version `0.0.0`; publishable package versions must be changed only after ownership evidence is ready.                                     |

## Release Rule

The project is locally ready for continued maintainer release work when the
local verification commands pass. It is not ready for public beta or stable 1.0
until every blocking evidence command above passes against real, redaction-safe
evidence and the pending approvals are replaced with dated, non-placeholder
signoffs.
