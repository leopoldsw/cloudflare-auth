# Public Beta

Public beta starts only after private-alpha evidence is recorded, the Deploy to
Cloudflare button evidence is verified, and the package names are confirmed.

## Required Evidence

- `CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence` passes against `docs/alpha-evidence.json`
- `CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence` passes against `docs/deploy-button-evidence.json`
- `CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership` passes against `docs/package-ownership.json`
- `pnpm check:package-names` passes against `docs/package-ownership.json`
- published beta packages pass the documented quickstart from a clean directory in CI
- one maintainer completes the same quickstart manually
- one opt-in Cloudflare account fixture passes the production path:

```bash
npx --package @cf-auth/cli@beta cf-auth setup --env production
```

or its granular equivalent:

```bash
npx --package @cf-auth/cli@beta cf-auth doctor --env production
npx --package @cf-auth/cli@beta cf-auth migrate --remote --env production
npx --package @cf-auth/cli@beta cf-auth deploy --env production
```

The checked-in opt-in workflow for this gate is
`.github/workflows/published-quickstart-smoke.yml`. It runs
`npx --package @cf-auth/cli@<package_tag> cf-auth init` from a clean temporary
directory, verifies the generated app has no `workspace:*` dependencies, builds
it, applies local migrations, starts `wrangler dev`, and exercises signup/login.

The checked-in opt-in workflow for the production account gate is
`.github/workflows/cloudflare-production-smoke.yml`. It requires a dedicated
Worker/D1 fixture, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID`, `CF_AUTH_PRODUCTION_SMOKE_ORIGIN`, and
the `CF_AUTH_PRODUCTION_SMOKE=1` safety flag. Set workflow input `package_tag`
to the `beta` dist-tag or a concrete `x.y.z-beta.*` prerelease version to
verify published beta packages; leave it empty to verify local tarballs from
the current checkout.

- the template repository is public and contains no workspace-only dependency references
- `SECURITY.md` is linked from the README and includes supported versions, reporting channel, and response window
- `docs/known-limitations.md` is linked from public docs

## Package Name Gate

Do not publish public beta docs that use unscoped package commands until those package names are controlled by maintainers. Use the scoped fallback from `docs/decisions/package-naming.md` until then.

## Template Repository

The beta template repository must be generated from `templates/hono-basic` and then verified outside the monorepo:

```bash
CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG=beta \
node scripts/export-deploy-template.mjs /tmp/cloudflare-auth-template
cd /tmp/cloudflare-auth-template
pnpm install
pnpm build
npx --package @cf-auth/cli@beta cf-auth migrate --local
npm run dev
```

The template must include published package versions, not `workspace:*`
dependencies. `pnpm verify:deploy-template` checks the generated template shape,
including D1 binding metadata and the deploy script that applies migrations
through the `AUTH_DB` binding.

## Before 1.0

Copy `docs/beta-evidence.example.json` to `docs/beta-evidence.json` and
record redaction-safe public-beta evidence before stable 1.0. Do not include
raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API
tokens:

```bash
CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence
```

Schema version 2 binds evidence to the exact GitHub repository, the complete
publishable package-name set, and successful workflow runs. Record the full
`headSha` for both the published-quickstart and production-smoke runs. The
verifier resolves each run through the GitHub API and requires the expected
workflow path, repository, commit, completed status, and successful conclusion.
Evidence must be no more than 30 days old.

In GitHub Actions, the release workflow supplies its scoped `GITHUB_TOKEN`.
For a required local verification, set `CF_AUTH_EXPECTED_REPOSITORY=owner/repo`
and `GITHUB_TOKEN` with read access to Actions, issues, and repository security
advisories. The JSON fixture override is test-only and is not exposed by any
checked-in workflow.
