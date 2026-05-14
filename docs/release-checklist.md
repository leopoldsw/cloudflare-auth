# Release Checklist

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
- `pnpm verify:alpha-evidence`
- `pnpm verify:deploy-template`
- `pnpm verify:migrations`
- `pnpm verify:examples`
- `pnpm verify:security-tracker`
- `pnpm release:gates`
- `CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs`
- `pnpm benchmark:password`

## Prerelease

- package names confirmed or fallback docs updated
- release workflow `package_names_confirmed` gate set only after package names are verified
- local clean-directory quickstart passes
- private-alpha evidence verifier passes before public beta
- `doctor --report` attached to the release issue
- known limitations reviewed
- unresolved high/critical auth security issues checked

## Public Beta

- beta packages published from a dry-run artifact
- published quickstart smoke workflow passes using the beta package tag
- generated Deploy to Cloudflare template passes `pnpm verify:deploy-template`
- maintainer manually verifies the quickstart
- opt-in Wrangler dev smoke workflow passes for at least one Worker example
- opt-in Cloudflare production smoke workflow passes against the dedicated fixture
- production smoke test passes against an opt-in Cloudflare account fixture
- Deploy to Cloudflare button path verified or explicitly blocked

## 1.0

- public API report reviewed and release-approved
- config schema reviewed and release-approved
- upgrade tests cover every beta schema version
- security review decision record signed
- security release tracker verifier passes
- Dependabot, dependency review, and CodeQL automation are enabled
- opt-in Wrangler dev smoke workflow passes for the release candidate
- opt-in Cloudflare production smoke workflow passes for the release candidate
- README, LICENSE, export maps, package contents, and provenance settings pass `pnpm package:check`
