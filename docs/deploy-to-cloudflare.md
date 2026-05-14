# Deploy To Cloudflare Button

The Deploy to Cloudflare button is a public-beta gate. Do not add it to the README until the template repository and smoke test are passing.

## Button Target

Cloudflare's Deploy to Cloudflare button clones a public GitHub or GitLab
repository, reads its Wrangler configuration, can provision resources such as
D1, and has monorepo limitations. Generate an isolated template repository
instead of targeting this monorepo:

```bash
CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG=beta \
node scripts/export-deploy-template.mjs /tmp/cloudflare-auth-template
```

Verify the generated template before publishing it:

```bash
pnpm verify:deploy-template
```

When the template repository is public, configure the button to deploy that
repository:

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/cloudflare-auth-template)
```

Replace `OWNER/cloudflare-auth-template` with the released starter template.
Do not link the button from the README until the generated template has been
published to its own public repository and the button flow has been verified.
Copy `docs/deploy-button-evidence.example.json` to
`docs/deploy-button-evidence.json` and record redaction-safe button-flow
evidence before public beta. Do not include raw secrets, tokens, cookies,
emails, IPs, user agents, or Cloudflare API tokens:

```bash
CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence
```

## Acceptance Path

The button flow must prove:

- starter template is created
- D1 binding is configured for `AUTH_DB`
- migrations are applied or the user is given the exact command to apply them
- `AUTH_SECRET` and `AUTH_PUBLIC_ORIGIN` are configured
- deployed `/auth/signup`, `/auth/login`, `/auth/logout`, and `/auth/user` smoke tests pass

If any step remains manual, the button docs must state the exact value the user must provide and the exact command to continue.
