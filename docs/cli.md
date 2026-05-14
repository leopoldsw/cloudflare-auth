# CLI Reference

The `cf-auth` binary is the supported entrypoint. Before unscoped package
publication, use `npx --package @cf-auth/cli@latest cf-auth ...` as the
fallback.

## Scaffold

```bash
npx --package @cf-auth/cli@latest cf-auth init my-app --template hono-basic
npx --package @cf-auth/cli@latest cf-auth init worker-app --template worker-basic
npx --package @cf-auth/cli@latest cf-auth init --dry-run
```

`init` writes a runnable Worker auth app or prints route snippets in dry-run
mode. Generated projects keep local and production Wrangler environments
separate. Supported templates are `hono-basic` and `worker-basic`.

## Migrations

```bash
npx --package @cf-auth/cli@latest cf-auth migrate --local
npx --package @cf-auth/cli@latest cf-auth migrate --status --local
npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production
npx --package @cf-auth/cli@latest cf-auth migrate --status --remote --env production
```

Remote migrations require `--env` when the Wrangler config has named
environments.

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
`schemas/doctor-report.schema.json`. `deploy` always runs `doctor` first.

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
environment variable so shell history does not capture the value.

## Cleanup

```bash
npx --package @cf-auth/cli@latest cf-auth clean --local
npx --package @cf-auth/cli@latest cf-auth clean --dry-run --remote --env production
npx --package @cf-auth/cli@latest cf-auth clean --remote --env production
```

Cleanup removes expired sessions, expired or used verification tokens, expired
rate-limit rows, and old auth events using the documented retention windows.

## Recovery Helpers

```bash
npx --package @cf-auth/cli@latest cf-auth users disable person@example.com --remote --env production
npx --package @cf-auth/cli@latest cf-auth users enable usr_... --remote --env production
npx --package @cf-auth/cli@latest cf-auth sessions list --user person@example.com --remote --env production
npx --package @cf-auth/cli@latest cf-auth sessions revoke --user usr_... --remote --env production
```

Recovery helpers redact SQL output and never print tokens, token hashes,
cookies, raw IPs, or raw user agents. Add `--dry-run` to mutating commands
before executing production changes.
