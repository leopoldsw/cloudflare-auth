# Automation Contract

This document is the contract between Cloudflare Auth and any automation that
deploys it: CI pipelines, provisioning scripts, and autonomous coding agents.
The deterministic CLI does the work; automation supplies credentials, invokes
one command, and applies machine-readable fixes. Anything the platform keeps
human-only is listed in [Manual Cloudflare Setup](manual-steps.md) and must be
handed to a person.

## Inputs

Automation needs the Wrangler CLI and two environment variables:

```bash
export CLOUDFLARE_ACCOUNT_ID="<32-character-account-id>"
export CLOUDFLARE_API_TOKEN="<scoped-api-token>"
```

Create the token with the exact least-privilege scopes in
[Cloudflare API Permissions](cloudflare-permissions.md). Interactive operators
can use `wrangler login` instead. Never write the token into `wrangler.jsonc`,
`.dev.vars`, or any committed file.

## The one command

From an initialized application directory (created by `cf-auth init` or an
existing app repaired by `init --repair`):

```bash
npx --package @cf-auth/cli@latest cf-auth setup --env production
```

`setup` runs, in order: preflight, public-origin validation, D1 provisioning,
remote migrations with schema verification, remote `AUTH_SECRET` creation
only when the secret is missing, `doctor`, `wrangler deploy`, and HTTP
verification of the deployed `/auth` endpoints. If `AUTH_PUBLIC_ORIGIN` is not
configured yet, pass `--origin <https-origin>`. Preview the full plan first in
an unfamiliar account:

```bash
npx --package @cf-auth/cli@latest cf-auth setup --dry-run --env production
```

## The convergence loop

This loop is normative for agents and unattended automation:

1. Run
   `npx --package @cf-auth/cli@latest cf-auth setup --report --env production`
   (add `--output setup-report.json` to write the report to a file) and parse
   the JSON against `schemas/setup-report.schema.json`.
2. If `ok` is `true`, stop: the auth Worker is deployed and verified.
3. Otherwise execute each failed step's `fix` string exactly as printed.
4. If a failure references a human-only step, stop and hand the exact numbered
   step from [Manual Cloudflare Setup](manual-steps.md) to a human operator.
   Never automate the Cloudflare dashboard.
5. Rerun step 1. Bound the loop to 5 iterations and stop early when two
   consecutive runs report identical failure sets; summarize what remains.

The same loop applies to
`npx --package @cf-auth/cli@latest cf-auth doctor --report --env production`
for diagnosis without mutation.

## Guarantees

- **Idempotent.** Every step is safe to rerun; a rerun after success performs
  no resource creation, secret writes, or config rewrites.
- **Non-interactive.** No step prompts. Failures exit nonzero with exactly one
  `Next action:` line in human mode and one `nextAction` field in report mode.
- **One executable fix per failure.** Each failed step carries a `fix` that is
  either a single runnable command in the
  `npx --package @cf-auth/cli@latest cf-auth ...` form or one exact
  configuration or dashboard instruction.
- **Never rotates secrets.** `setup` creates `AUTH_SECRET` only when it is
  missing. Rotation is a separate, deliberate `rotate-secret` operation.
- **Redaction-safe output.** Reports and messages never contain raw secrets,
  tokens, cookies, emails, IPs, or user agents.
- **Config mutations are backed up.** Wrangler config patches write a sibling
  `.cf-auth-backup` first and replace files atomically.

## Boundaries

Email sender/domain onboarding with its DNS records, the Workers Paid plan,
Turnstile widget creation, workers.dev subdomain registration, custom domains,
and the choice of public origin are human steps; each has an exact runbook
entry with a completion check in [Manual Cloudflare Setup](manual-steps.md).
The granular five-command sequence remains documented as an escape hatch in
[Deployment](deployment.md).

## Agent packaging

- `cf-auth init` writes a self-contained `AGENTS.md` runbook into every
  scaffolded app so any coding agent working in that repository knows the
  local loop, the one command, this convergence loop, the token scopes, and
  the human-only steps.
- This repository ships a Claude Code project skill at
  `.claude/skills/cf-auth-setup/SKILL.md` implementing the loop with preflight
  and manual-step handoff rules. Publishing it as a plugin/marketplace entry
  is a post-beta follow-up.
- No MCP server is planned for v1 or public beta: terminal agents already have
  the required capability through this CLI, and Cloudflare ships official MCP
  servers for platform access. A future MCP server would wrap this same
  report contract rather than reimplement provisioning.
