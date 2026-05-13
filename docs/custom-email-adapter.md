# Custom Email Adapter

Custom adapters implement the `AuthEmailAdapter` interface and receive runtime `env`, `ctx`, `mode`, `requestId`, `publicOrigin`, and a redacting logger.

Adapter factories should store binding names or option values, not Worker binding instances.

Use this for providers such as Resend, Postmark, or an internal service binding. Do not log raw token links in adapter errors.

```ts
export function customEmail(): AuthEmailAdapter {
  return {
    async sendMagicLink(input, runtime) {
      const apiKey = runtime.env.RESEND_API_KEY;
      await sendWithProvider({ apiKey, to: input.to, url: input.url });
    },
    async sendEmailVerification(input, runtime) {
      await sendWithProvider({ to: input.to, url: input.url });
    },
    async sendPasswordReset(input, runtime) {
      await sendWithProvider({ to: input.to, url: input.url });
    },
  };
}
```

Providers such as Resend and Postmark should be wired through this interface in application code. They are not core dependencies.
