# Rate Limiting

The MVP uses D1 fixed-window rate limits. Stored keys are derived with HMAC and include the action and subject type:

```text
rl:v1:<action>:<subject-type>:<hmac>
```

Raw emails, identifiers, and IP addresses are never stored in `rate_limits`.

If an `AUTH_RATE_LIMITER` binding is present, the Worker calls it before writing D1 counters:

```ts
await cloudflareRateLimitPrefilter({
  env,
  key: "password_login:rl:v1:password_login:ip:<hmac>",
});
```

The binding is an edge-abuse prefilter only. D1 remains authoritative for account-sensitive auth decisions because it tracks both the IP key and the account/identifier key inside the auth database.

Use Cloudflare's current Rate Limiting binding documentation for the `wrangler.jsonc` binding shape. The runtime expects a binding with `limit({ key })` returning `{ success: boolean }`.

Tests in `tests/routes.test.ts` verify opaque D1 keys. Tests in `tests/security-hardening.test.ts` verify that a denied Cloudflare prefilter prevents D1 writes and user creation.
