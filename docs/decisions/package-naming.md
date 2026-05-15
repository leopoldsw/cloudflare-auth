# Package Naming

Cloudflare Auth uses the public package scope `@cf-auth/*` and the CLI binary name `cf-auth`.

## Packages

| Package                     | Purpose                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `cf-auth`                   | Thin unscoped CLI shim, publishable only if maintainers control the occupied npm name. |
| `@cf-auth/cli`              | Real CLI implementation.                                                               |
| `create-cloudflare-auth`    | Create-package entry, publishable only after maintainers control the npm name.         |
| `@cf-auth/core`             | Core auth contracts and logic.                                                         |
| `@cf-auth/worker`           | Cloudflare Worker runtime.                                                             |
| `@cf-auth/hono`             | Hono adapter.                                                                          |
| `@cf-auth/client`           | Browser SDK.                                                                           |
| `@cf-auth/email-cloudflare` | Cloudflare Email adapter.                                                              |
| `@cf-auth/testing`          | Test helpers.                                                                          |

## Availability Rules

Public docs may use `npx cf-auth@latest ...` only if the unscoped `cf-auth` package is controlled by the maintainers and delegates to `@cf-auth/cli`.

As of May 15, 2026, `npm view cf-auth name version --json` returns `cf-auth@1.0.2`. Until maintainers explicitly prove control of that package, public docs must not use `npx cf-auth@latest`.

As of May 15, 2026, `npm view <name> name version --json` returns `E404` for
every publishable `@cf-auth/*` package in this repo: `@cf-auth/cli`,
`@cf-auth/client`, `@cf-auth/core`, `@cf-auth/email-cloudflare`,
`@cf-auth/hono`, `@cf-auth/testing`, and `@cf-auth/worker`. Until maintainers
create and control the `@cf-auth/*` scope, public release docs must remain
behind the package-name gate or switch every package name, import, template,
test, and doc to the approved fallback scope.

As of May 15, 2026, `npm view create-cloudflare-auth name version --json` returns `E404`. Until maintainers create and control that package, public docs must not use `npm create cloudflare-auth`.

If `cf-auth` is unavailable, public docs must use:

```bash
npx --package @cf-auth/cli@latest cf-auth init
```

If the `@cf-auth/*` scope is unavailable, maintainers must use the approved fallback scope `@cloudflare-auth/*` and update every package name, import, generated template, test, and doc consistently before publication.

If `create-cloudflare-auth` is unavailable, public new-app docs must use:

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
```

The command `npm create cloudflare-auth@latest my-app` may appear in public quickstarts only after the unscoped create package is controlled by maintainers.
Until then, the `cf-auth` shim and `create-cloudflare-auth` workspace packages
must remain private implementation entrypoints that are built and tested
locally but skipped by release publication.

## Release Controls

Before publishing a prerelease or stable release, maintainers must verify package
ownership for every published name or complete the fallback rename.
npm publisher 2FA must be enabled for every publishing account, and the release
workflow must publish from GitHub Actions with npm provenance.

Copy `docs/package-ownership.example.json` to `docs/package-ownership.json`
and record redaction-safe ownership evidence before publishing prerelease or
stable packages:

```bash
CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership
pnpm check:package-names
```

The `version` values in `docs/package-ownership.json` must match the target
package versions in `packages/*/package.json`. The verifier rejects placeholder
`0.0.0` package versions.

Release package versions must use one of the supported implementation-plan
channels:

- private alpha: `x.y.z-alpha.N` or another `x.y.z-alpha.*` prerelease
- public beta: `x.y.z-beta.N` or another `x.y.z-beta.*` prerelease
- stable: `1.0.0` or later without a prerelease suffix

Do not publish other prerelease shapes such as `rc`, `next`, or unclassified
`0.x` stable versions unless the implementation plan is updated and
`pnpm release:gates` is changed with tests.

For an already-published npm name, include `registryVersion` with the current
registry version at review time. The registry check fails if that value is stale
or if the target package version already exists.

Do not include npm tokens, auth-token environment variables, or registry
session data in the evidence file.
