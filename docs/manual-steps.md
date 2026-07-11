# Manual Cloudflare Setup

Everything in this runbook is a step the platform keeps human-only. Automation
(including `cf-auth setup` and coding agents following
[Automation Contract](automation.md)) must stop and hand these to a person,
then rerun setup. Each step says why it is manual, where to do it, and how you
know it is done.

## 1. Create a Cloudflare account

- **Why manual:** account creation, identity, and billing are yours alone.
- **Where:** [dash.cloudflare.com](https://dash.cloudflare.com) → Sign up.
- **Done when:** `wrangler login` succeeds, or step 2's token works.

## 2. Create a scoped API token and export it

- **Why manual:** minting credentials must be a deliberate human act; the
  token is the blast radius of everything automation can do.
- **Where:** Dashboard → My Profile → API Tokens → Create Token → Custom
  token, with the exact scopes in
  [Cloudflare API Permissions](cloudflare-permissions.md). Then:

  ```bash
  export CLOUDFLARE_ACCOUNT_ID="<32-character-account-id>"
  export CLOUDFLARE_API_TOKEN="<scoped-api-token>"
  ```

- **Done when:** `wrangler whoami` lists the target account; the setup
  `preflight` step passes.

## 3. Register a workers.dev subdomain (first deploy only)

- **Why manual:** the subdomain is a one-time, account-wide naming decision;
  Wrangler has no non-interactive command for it, so a first deploy on a fresh
  account fails fast with an onboarding URL.
- **Where:** the `https://dash.cloudflare.com/<account-id>/workers/onboarding`
  URL printed by the failed deploy step, or Dashboard → Workers & Pages.
- **Done when:** rerunning
  `npx --package @cf-auth/cli@latest cf-auth setup --env production` passes
  the `deploy` step and prints your `https://<worker>.<subdomain>.workers.dev`
  URL.

## 4. Enable the Workers Paid plan (required for Email Sending)

- **Why manual:** it is a billing decision.
- **Where:** Dashboard → Workers & Pages → Plans.
- **Done when:** Email Sending appears as available in the dashboard Email
  section.

## 5. Onboard the email sender domain and publish its DNS records

- **Why manual:** proving domain ownership and publishing SPF/DKIM/DMARC
  records happens at your DNS provider, and propagation takes real time.
  Cloudflare Auth never automates this; see
  [Cloudflare Email](cloudflare-email.md) for constraints.
- **Where:** Dashboard → Email → Email Sending → add and verify the sender
  domain; publish the records it lists (at your registrar if DNS is external).
- **Done when:** the dashboard shows the domain verified,
  `npx --package @cf-auth/cli@latest cf-auth doctor --env production` passes
  the `email_binding` check, and a real password-reset email arrives.

## 6. Create a Turnstile widget (only when Turnstile is enabled)

- **Why manual:** widget creation binds your hostname and issues a secret that
  must be stored deliberately.
- **Where:** Dashboard → Turnstile → Add widget, then store the secret:

  ```bash
  wrangler secret put TURNSTILE_SECRET_KEY --env production
  ```

- **Done when:** the doctor `turnstile_secret` check passes and the widget
  renders on your auth pages (see [Turnstile](turnstile.md)).

## 7. Configure a custom domain or route (optional)

- **Why manual:** domain purchase, zone setup, and nameserver delegation are
  external decisions; a plain workers.dev deployment needs none of this.
- **Where:** Dashboard → your zone → Workers Routes, or a Custom Domain on the
  Worker; DNS records at your registrar when the zone is external.
- **Done when:** the custom origin serves `/auth/user` over HTTPS.

## 8. Choose the exact public origin

- **Why manual:** the canonical origin is a product decision that emailed
  links, cookies, and CORS all depend on.
- **Where:** decide between your workers.dev URL and a custom domain, then
  set it:

  ```bash
  npx --package @cf-auth/cli@latest cf-auth setup --env production --origin https://app.example.com
  ```

- **Done when:** the setup `origin` step passes and `AUTH_PUBLIC_ORIGIN`
  exactly matches the origin that serves this Worker (the `verify` step proves
  it end to end).
