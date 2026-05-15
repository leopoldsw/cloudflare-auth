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

Set `rateLimit.edgePrefilter` to `disabled` to skip the Cloudflare binding even when `AUTH_RATE_LIMITER` is present. `rateLimit.adapter` is fixed to `d1` in v1.

The binding is an edge-abuse prefilter only. D1 remains authoritative for account-sensitive auth decisions because it tracks both the IP key and the account/identifier key inside the auth database. If the optional binding is absent, throws, or returns a malformed response, the runtime fails open to the D1 limiter. Only an explicit `{ success: false }` response blocks before D1 writes.

Use Cloudflare's current Rate Limiting binding documentation for the `wrangler.jsonc` binding shape. The runtime expects a binding with `limit({ key })` returning `{ success: boolean }`.

Production deployments should use at least one edge-abuse control before D1 for signup, magic-link request, password-reset request, and token consume endpoints: a Cloudflare Rate Limiting API prefilter, a WAF rule, or Turnstile. These controls reduce traffic spikes before auth reaches D1; they do not replace the authoritative D1 counters.

Tests in `tests/routes.test.ts` verify opaque D1 keys. Tests in `tests/security-hardening.test.ts` verify that a denied Cloudflare prefilter prevents D1 writes and user creation.
