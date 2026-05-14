# Contributing

Cloudflare Auth is built as a pnpm monorepo. Keep changes scoped, add tests for auth behavior changes, and avoid broad refactors in security-sensitive code unless they are part of the requested work.

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in project spaces.

## Local Setup

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:workers
pnpm build
```

## Security-Sensitive Rules

- Never store raw session, magic-link, verification, or reset tokens.
- Never log secrets, passwords, raw tokens, raw emails, raw IPs, or raw user agents.
- Use prepared statements and bound parameters for SQL.
- Keep request-origin allowlists separate from redirect allowlists.
- Add regression tests for any bug that touches auth state, cookies, tokens, redirects, CORS, CSRF, rate limits, or password hashing.

## Changesets

Package changes require a changeset before release:

```bash
pnpm changeset
```
