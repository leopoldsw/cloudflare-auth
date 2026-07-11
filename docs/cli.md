# CLI Reference

The `cf-auth` binary is the supported entrypoint. Before unscoped package
publication, use `npx --package @cf-auth/cli@latest cf-auth ...` as the
fallback.

## Scaffold

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
npx --package @cf-auth/cli@latest cf-auth init worker-app --template worker-basic
npx --package @cf-auth/cli@latest cf-auth init --dry-run
npx --package @cf-auth/cli@latest cf-auth init --repair
```

`init` writes a runnable Worker auth app or prints route snippets in dry-run
mode. Generated projects keep local and production Wrangler environments
separate. For existing apps, `init` preserves `wrangler.json` versus
`wrangler.jsonc` and restores missing auth Wrangler vars, D1 bindings, Workers
compatibility settings, production email binding, and migration files without
changing existing app source. When an existing Wrangler config is patched,
`init` writes a sibling `.cf-auth-backup` file first. `init --repair` reruns the
same safe repair path. Supported templates are `hono-basic` and `worker-basic`.

Before creating `.dev.vars`, `init` merges the required `.gitignore` entries
without removing project-specific entries. It creates `.dev.vars` with mode
`0600` on platforms with POSIX permissions and tightens an existing regular
`.dev.vars` to that mode without replacing its contents. Writes to package,
Wrangler config, backup, and local-secret paths reject symbolic-link targets;
new files use exclusive creation and updates use same-directory atomic
replacement. Unsafe symbolic-link child directories are also rejected.

New projects pin Hono `4.12.29`, TypeScript `7.0.2`, Wrangler `4.110.0`, and
Vitest `4.1.10`, and use Workers compatibility date `2026-07-11` with
`nodejs_compat`.

## Provision Production D1

```bash
npx --package @cf-auth/cli@latest cf-auth provision --env production
npx --package @cf-auth/cli@latest cf-auth provision --env production --location weur
npx --package @cf-auth/cli@latest cf-auth provision --env production --jurisdiction eu
npx --package @cf-auth/cli@latest cf-auth provision --dry-run --env production
```

`provision` requires exactly one `AUTH_DB` binding in the selected environment.
It lists D1 databases in the selected account, adopts the single exact
`database_name` match, or creates the database and re-discovers its UUID. It
then writes a sibling `.cf-auth-backup` and atomically patches `database_id`.
Repeated runs are idempotent. A configured, usable ID that disagrees with the
selected account is rejected instead of silently retargeted.

The patched config is normalized to JSON, so JSONC comments are not copied into
the updated file. A newly created backup preserves the original bytes, including
comments. If the sibling backup already exists, it is left untouched and the
CLI reports that the existing backup was preserved rather than claiming to have
written a new one.

`--location` accepts Wrangler's current D1 location hints: `weur`, `eeur`,
`apac`, `oc`, `wnam`, or `enam`. `--jurisdiction` accepts `eu` or `fedramp`.
The two flags are mutually exclusive. Dry-run prints the list/create/patch plan
without calling Wrangler or changing files.

All non-dry-run remote commands select an account deterministically and verify
that it appears in `wrangler whoami --json` before mutation. Precedence is:

1. `env.<selected>.account_id`
2. root `account_id`
3. `CLOUDFLARE_ACCOUNT_ID`

When none is set, only `provision` may use Wrangler's account list, and only
when exactly one account is accessible; it then records that account in the
root config. Other remote commands require an explicit selection. This avoids
silently mutating a different account when Wrangler credentials can access
multiple accounts.

## Setup

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production
npx --package @cf-auth/cli@latest cf-auth setup --report --env production
npx --package @cf-auth/cli@latest cf-auth setup --report --env production --output setup-report.json
npx --package @cf-auth/cli@latest cf-auth setup --dry-run --env production
npx --package @cf-auth/cli@latest cf-auth setup --env production --origin https://app.example.com
npx --package @cf-auth/cli@latest cf-auth setup --env production --skip-verify
```

`setup` is the one-command production path. In an initialized app it runs, in
order: preflight (Wrangler availability, config and environment selection,
Cloudflare account access), public-origin validation, `provision`, remote
migrations with schema verification, remote `AUTH_SECRET` creation only when
the secret is missing (it never rotates an existing secret), `doctor`,
`wrangler deploy`, and an HTTP verification of the deployed `/auth` signup,
login, and logout flows using a throwaway user that is disabled afterwards.
Every step is idempotent, non-interactive, and rerunnable; the first failed
step stops the run, marks later steps skipped, and prints exactly one
`Next action:` line.

`setup --report` emits redaction-safe JSON matching
`schemas/setup-report.schema.json`; each failed step carries an executable
`fix` string and the report embeds the full doctor report when the doctor step
ran. Reports written with `--output` use mode `0600`, reject symbolic-link
targets, and are atomically replaced. `--origin` validates an exact `https`
origin and patches `vars.AUTH_PUBLIC_ORIGIN` for the selected environment
after writing a sibling `.cf-auth-backup`. `--location` and `--jurisdiction`
pass through to first-time D1 creation. `--skip-verify` skips the deployed
endpoint verification. `--dry-run` prints the full planned step sequence
without calling Wrangler, changing files, or making network requests.

The report-driven convergence loop for coding agents and CI is specified in
[Automation Contract](automation.md); the granular command sequence remains
available in [Deployment](deployment.md).

## Migrations

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --local
npx --package @cf-auth/cli@latest cf-auth migrate --status --local
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth migrate --status --remote --env production
npx --package @cf-auth/cli@latest cf-auth migrate --dry-run --remote --env production
```

Remote migrations require `--env` when the Wrangler config has named
environments. The CLI reads migration versions from the selected `AUTH_DB`
binding's `migrations_dir` (default `migrations`) when verifying the applied
schema. Exactly one complete `AUTH_DB` binding is required. `--dry-run` prints
the exact Wrangler command without running it or performing account discovery.

## Doctor And Deploy

```bash
npx --package @cf-auth/cli@latest cf-auth doctor
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production
npx --package @cf-auth/cli@latest cf-auth doctor --report --env production --output auth-doctor-report.json
npx --package @cf-auth/cli@latest cf-auth deploy --dry-run --env production
npx --package @cf-auth/cli@latest cf-auth deploy --migrate --env production
npx --package @cf-auth/cli@latest cf-auth deploy --env production
```

`doctor --report` emits redaction-safe JSON matching
`schemas/doctor-report.schema.json`. `doctor` checks the required Workers
compatibility date and `nodejs_compat` flag. It also warns when `.dev.vars`
allows group or other access and recommends `chmod 600 .dev.vars`. Reports
written with `--output` use mode `0600` on platforms with POSIX permissions,
reject symbolic-link targets, and are atomically replaced. `deploy` always runs
`doctor` first. `deploy --migrate` treats an uninitialized D1 auth schema as
pending, applies migration `0001` and later migrations, verifies the resulting
schema, and only then deploys.

Add `--verbose` to log the wrapped Wrangler commands to stderr. Verbose output
redacts SQL passed through `wrangler d1 execute` so `doctor --report` remains
machine-readable on stdout.

## Generate Snippets

```bash
npx --package @cf-auth/cli@latest cf-auth generate hono
npx --package @cf-auth/cli@latest cf-auth generate worker-snippet
npx --package @cf-auth/cli@latest cf-auth generate react-client
npx --package @cf-auth/cli@latest cf-auth generate types
```

`generate` prints small copyable snippets and does not edit source files.

## Secrets

```bash
npx --package @cf-auth/cli@latest cf-auth rotate-secret --print
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --previous-from-stdin --env production
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --previous-from-env AUTH_SECRET_OLD --env production
```

Do not pass old raw secrets as command-line arguments. Use stdin or an
environment variable so shell history does not capture the value. Apply mode
sends one JSON document to `wrangler secret bulk`, so `AUTH_SECRET` and
`AUTH_SECRET_PREVIOUS` change atomically. When no previous secret is supplied,
the bulk document sets `AUTH_SECRET_PREVIOUS` to `null`, removing an old value
in the same operation; existing sessions and email tokens will be invalidated.
Wrangler creates and deploys a Worker version for a bulk secret update. On a
fresh installation, apply D1 migrations before this command; on an existing
installation, treat it as an immediate production deployment.

## Cleanup

```bash
npx --package @cf-auth/cli@latest cf-auth clean --local
npx --package @cf-auth/cli@latest cf-auth clean --dry-run --remote --env production
npx --package @cf-auth/cli@latest cf-auth clean --remote --env production
```

Cleanup removes expired sessions, expired, used, or revoked verification tokens,
expired rate-limit rows, and old auth events using the documented retention
windows. Cutoffs are derived from D1's `strftime('now')` server clock rather
than the operator machine's clock.

## Recovery Helpers

```bash
npx --package @cf-auth/cli@latest cf-auth users disable person@example.com --remote --env production
npx --package @cf-auth/cli@latest cf-auth users enable usr_... --remote --env production
npx --package @cf-auth/cli@latest cf-auth sessions list --user person@example.com --remote --env production
npx --package @cf-auth/cli@latest cf-auth sessions revoke --user usr_... --remote --env production
```

Recovery helpers redact SQL output and never print tokens, token hashes,
cookies, raw IPs, or raw user agents. Add `--dry-run` to mutating commands
before executing production changes. Remote cleanup and recovery commands should
use `--env production`; without `--env`, the top-level Wrangler config must set
`vars.AUTH_ENV=production`. Disable, enable, and revoke timestamps are derived
from the D1 server clock.
