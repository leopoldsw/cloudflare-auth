# Cloudflare Email

The production adapter uses a Worker `send_email` binding resolved from `env` at request time.

Generated binding name:

```text
AUTH_EMAIL
```

If the binding is missing, `cf-auth doctor --env production` reports the missing binding and suggests the exact Wrangler config change. Local development does not require Cloudflare Email; it uses terminal email by default.

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
