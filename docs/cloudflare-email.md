# Cloudflare Email

The production adapter uses a Worker `send_email` binding resolved from `env` at request time.

Generated binding name:

```text
AUTH_EMAIL
```

If the binding is missing, `cf-auth doctor --env production` reports the missing binding and suggests the exact Wrangler config change. Local development does not require Cloudflare Email; it uses terminal email by default.

## Production Constraints

Cloudflare Email Service is currently beta and the outbound Email Sending
feature is available on Workers Paid. Cloudflare's setup flow also requires the
sending domain to use Cloudflare DNS.

Before switching preview or production to `cloudflareEmail(...)`:

- onboard the sending domain in Cloudflare Email Sending
- add the Cloudflare-generated DNS records for bounce handling, SPF, DKIM, and DMARC
- wait for DNS propagation before treating production email as ready
- keep local development on `terminalEmail(...)` unless you intentionally want local `wrangler dev` calls to send real email through a remote binding

Current Cloudflare references:

- [Cloudflare Email Service overview](https://developers.cloudflare.com/email-service/)
- [Send emails setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)

## Adapter

```ts
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

cloudflareEmail({
  binding: "AUTH_EMAIL",
  from: { email: "auth@example.com", name: "My App" },
  appName: "My App",
});
```

The adapter sends plaintext and HTML messages, includes the app name and expiration time, and does not add tracking pixels or third-party assets.

Generated apps should select adapters by runtime environment:

```ts
import { cloudflareEmail } from "@cf-auth/email-cloudflare";
import { byEnvironment, terminalEmail } from "@cf-auth/worker";

byEnvironment({
  development: terminalEmail({ outbox: true }),
  preview: cloudflareEmail({
    binding: "AUTH_EMAIL",
    from: { email: "auth@example.com", name: "My App" },
  }),
  production: cloudflareEmail({
    binding: "AUTH_EMAIL",
    from: { email: "auth@example.com", name: "My App" },
  }),
});
```

Template hooks can override each message type:

```ts
cloudflareEmail({
  binding: "AUTH_EMAIL",
  from: "auth@example.com",
  templates: {
    magicLink(input) {
      return {
        subject: `Sign in to ${input.appName}`,
        text: input.url,
        html: `<a href="${input.url}">Sign in</a>`,
      };
    },
  },
});
```
