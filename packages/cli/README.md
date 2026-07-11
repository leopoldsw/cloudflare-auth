# @cf-auth/cli

CLI implementation for Cloudflare Auth. It provides project scaffolding, a
one-command production setup, D1 provisioning, migrations, diagnostics, deploy
gates, atomic secret rotation, cleanup, and recovery helpers.

Common production flow:

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production
```

`setup` composes the granular commands below — provision, remote migrations,
missing-secret creation (never rotating an existing secret), doctor, deploy,
and deployed-endpoint verification — into one idempotent, non-interactive
command with a machine-readable `--report` mode. Each stage remains available
individually:

```bash
npx --package @cf-auth/cli@latest cf-auth provision --env production
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production
npx --package @cf-auth/cli@latest cf-auth doctor --env production
npx --package @cf-auth/cli@latest cf-auth deploy --env production
```

Remote commands require one complete `AUTH_DB` binding and a deterministic
Cloudflare account. Account selection precedence is the selected Wrangler
environment's `account_id`, root `account_id`, then
`CLOUDFLARE_ACCOUNT_ID`; the selected ID is checked against
`wrangler whoami --json` before a remote mutation. `provision` can select the
only accessible account when no ID is configured, discovers or creates the D1
database, backs up the Wrangler config, and patches `database_id` safely.

Generated local secrets and file-backed doctor reports use mode `0600` on
platforms with POSIX permissions; `init` also tightens an existing regular
`.dev.vars` without replacing its contents. Config, package, backup, report,
and local secret writes reject symbolic-link targets and use exclusive creation
or same-directory atomic replacement. Provisioning normalizes JSONC to JSON and
preserves the original bytes in a sibling backup. Remote secret rotation updates
`AUTH_SECRET` and `AUTH_SECRET_PREVIOUS` together with `wrangler secret bulk`;
Wrangler creates and deploys a Worker version for that update, so migrate a
fresh D1 database first.

See `docs/cli.md` in the repository for the complete command reference.

Cloudflare Auth is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Cloudflare.
