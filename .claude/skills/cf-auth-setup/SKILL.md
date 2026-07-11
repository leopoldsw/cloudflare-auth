---
name: cf-auth-setup
description:
  Provision, migrate, secure, deploy, and verify a Cloudflare Auth app's
  production environment with one idempotent command and a report-driven
  convergence loop. Use when asked to set up, deploy, fix, or diagnose a
  cf-auth / Cloudflare Auth application on Cloudflare.
---

# Cloudflare Auth one-command setup

The deterministic CLI does the work. Your job: check preconditions, run one
command, execute the fixes it reports, and hand human-only steps to the
operator. The normative contract is `docs/automation.md`; human-only steps are
`docs/manual-steps.md` (both in the Cloudflare Auth repository).

## Preflight

1. Confirm you are in an initialized app: a `wrangler.jsonc`/`wrangler.json`
   with an `AUTH_DB` D1 binding and a `src/auth.config.ts`. If not, run
   `npx --package @cf-auth/cli@latest cf-auth init` first (it also writes an
   AGENTS.md runbook).
2. Confirm credentials: `wrangler whoami` succeeds, or `CLOUDFLARE_ACCOUNT_ID`
   and `CLOUDFLARE_API_TOKEN` are exported with the scopes from
   `docs/cloudflare-permissions.md`. NEVER echo, log, or write these values.
3. In an account you have not deployed to before, show the plan first:

   ```bash
   npx --package @cf-auth/cli@latest cf-auth setup --dry-run --env production
   ```

## Run

```bash
npx --package @cf-auth/cli@latest cf-auth setup --report --env production --output setup-report.json
```

If the app has no `AUTH_PUBLIC_ORIGIN` configured yet, ask the user for the
intended https origin (or their workers.dev URL) and add
`--origin <https-origin>`.

## Converge (max 5 iterations)

1. Parse `setup-report.json` (schema: `schemas/setup-report.schema.json`).
2. `ok: true` → go to Verify.
3. For each step with `status: "fail"`, run its `fix` string exactly as
   printed. Do not improvise alternative commands.
4. If a fix references `docs/manual-steps.md` or a dashboard URL, STOP. Print
   the exact numbered manual step, where to do it, and its "done when" check,
   then wait for the operator. Never automate the Cloudflare dashboard.
5. Rerun the Run command. If two consecutive reports show identical failure
   sets, stop and summarize the remaining steps and the single next action.

## Verify

- `npx --package @cf-auth/cli@latest cf-auth doctor --env production` exits 0.
- The setup report's `verify` step is `pass` (setup already exercised signup,
  login, and logout against the deployed origin with a throwaway user unless
  `--skip-verify` was used).

## Failure quick reference

- `preflight` fails on accounts: export `CLOUDFLARE_ACCOUNT_ID` or set
  `account_id` in the Wrangler config.
- `origin` fails: rerun with `--origin <https-origin>` after confirming the
  origin with the user.
- `deploy` fails with a workers.dev onboarding URL: manual step 3 — the
  operator registers the subdomain once, then rerun setup.
- `doctor` email checks fail: manual steps 4–5 (Workers Paid, sender/domain
  DNS) — hand off, then rerun.
- `verify` fails: confirm the origin actually serves this Worker (route,
  custom domain, DNS) and inspect `wrangler tail --env production`.

## Invariants

- Setup never rotates an existing `AUTH_SECRET`; never run
  `rotate-secret --apply` on a live deployment without
  `--previous-from-env`/`--previous-from-stdin` and explicit user intent.
- Prefer `cf-auth` commands over raw `wrangler`; use `wrangler` only for
  diagnostics such as `whoami` and `tail`.
- Reports are redaction-safe; keep them that way — never paste secrets,
  cookies, or tokens into output or files.
