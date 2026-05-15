# Release Checklist

Use [release-readiness-audit.md](release-readiness-audit.md) to distinguish
local verification evidence from maintainer/manual evidence that must be
recorded before public beta or 1.0.

## Every Release

- `pnpm install --frozen-lockfile`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:workers`
- `pnpm build`
- `pnpm package:check`
- `pnpm version-matrix:check`
- `pnpm audit --audit-level high` reviewed as advisory evidence, not as the sole security gate
- `pnpm verify:alpha-evidence`
- `pnpm verify:beta-evidence`
- `pnpm verify:deploy-button-evidence`
- `pnpm verify:deploy-template`
- `pnpm verify:docs-coverage`
- `pnpm verify:migrations`
- `pnpm verify:examples`
- `pnpm verify:package-ownership`
- `pnpm verify:security-docs`
- `pnpm verify:security-tracker`
- `pnpm release:gates`
- `CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs`
- `pnpm benchmark:password`
- `pnpm publish:dry-run`

The evidence verifier scripts are version-aware and may skip when placeholder
`0.0.0` package versions are still checked in. A skipped verifier is not stage
evidence. When proving one of the release blockers below, run the explicit
`CF_AUTH_REQUIRE_*` command for that blocker.

## Prerelease

- package names confirmed or fallback docs updated
- platform assumptions rechecked in `docs/platform-assumptions.md`
- npm publisher 2FA and package ownership verified before dispatching the release workflow
- `CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership` passes before publishing prerelease or stable packages
- `pnpm check:package-names` passes before publishing prerelease or stable packages
- release workflow `package_names_confirmed` gate set only after package names are verified
- Changesets version/changelog output reviewed before publishing
- Changesets fixed package group keeps every publishable `@cf-auth/*` package on one release version
- dry-run publish summary artifact uploaded and reviewed before publishing
- local clean-directory quickstart passes
- private-alpha evidence verifier passes before public beta
- Deploy to Cloudflare button evidence verifier passes before public beta
- `doctor --report` attached to the release issue
- known limitations reviewed
- unresolved high/critical auth security issues checked
- secret scanning and push protection enabled or explicitly documented as unavailable

## Public Beta

- beta packages published from a dry-run artifact
- `CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence` passes against real private-alpha evidence
- `CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence` passes against real Deploy to Cloudflare evidence
- `CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership` passes against real npm ownership evidence
- `pnpm check:package-names` passes against real npm ownership evidence
- `pnpm smoke:published-quickstart` passes in the published quickstart smoke workflow using the beta package tag
- generated Deploy to Cloudflare template passes `pnpm verify:deploy-template`
- maintainer manually verifies the quickstart
- `pnpm smoke:wrangler-dev` passes in the opt-in Wrangler dev smoke workflow for at least one Worker example
- `pnpm smoke:cloudflare-production` passes in the opt-in Cloudflare production smoke workflow against the dedicated fixture
- `pnpm smoke:cloudflare-production` passes against an opt-in Cloudflare account fixture
- Deploy to Cloudflare button path verified with `pnpm verify:deploy-button-evidence`

## 1.0

- public API report reviewed and release-approved
- config schema reviewed and release-approved
- `CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence` passes against real public-beta evidence
- upgrade tests cover every beta schema version
- security review decision record signed
- `CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker` passes against the real security release tracker
- Dependabot, dependency review, and CodeQL automation are enabled
- `pnpm smoke:wrangler-dev` passes in the opt-in Wrangler dev smoke workflow for the release candidate
- `pnpm smoke:cloudflare-production` passes in the opt-in Cloudflare production smoke workflow for the release candidate
- README, LICENSE, export maps, package contents, and provenance settings pass `pnpm package:check`
