# Release Checklist

## Every Release

- `pnpm install --frozen-lockfile`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm package:check`
- `pnpm version-matrix:check`
- `pnpm verify:migrations`
- `pnpm verify:examples`
- `pnpm benchmark:password`

## Prerelease

- package names confirmed or fallback docs updated
- release workflow `package_names_confirmed` gate set only after package names are verified
- local clean-directory quickstart passes
- `doctor --report` attached to the release issue
- known limitations reviewed
- unresolved high/critical auth security issues checked

## Public Beta

- beta packages published from a dry-run artifact
- quickstart passes in CI using published beta versions
- maintainer manually verifies the quickstart
- production smoke test passes against an opt-in Cloudflare account fixture
- Deploy to Cloudflare button path verified or explicitly blocked

## 1.0

- public API report reviewed and release-approved
- config schema reviewed and release-approved
- upgrade tests cover every beta schema version
- security review decision record signed
- dependency review automation is enabled
- README, LICENSE, export maps, package contents, and provenance settings pass `pnpm package:check`
