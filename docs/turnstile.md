# Turnstile

Turnstile is optional and disabled by default. Enable it in `auth.config.ts`; there is no CLI alias because apps need to choose which user-facing flows receive a widget.

```ts
export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  turnstile: {
    mode: "required",
    endpoints: [
      "signup",
      "password_login",
      "magic_link_request",
      "password_reset_request",
    ],
  },
});
```

Set `TURNSTILE_SECRET_KEY` as a Worker secret when using the built-in verifier. `cf-auth doctor --env production` reports a missing secret when required mode is configured without a custom verifier. Clients submit the widget response as `turnstileToken` in JSON or form bodies.

The built-in verifier uses `contextBinding: "strict"` by default. In strict
mode, a successful Siteverify response must contain a `hostname` exactly equal
to the configured public-origin hostname and an `action` exactly equal to the
protected endpoint name below. Configure the Turnstile widget with that action;
for example, the password-login action is `password_login`.

Set `contextBinding: "disabled"` only when the widget is intentionally rendered
on a different hostname or cannot use endpoint actions and an equivalent
deployment-specific control is in place. This is an explicit reduction in
built-in context protection. Custom `turnstile.verify` implementations receive
`expectedHostname` and `expectedAction` in strict mode and remain responsible
for enforcing their own verification result.

Available endpoint names:

- `signup`
- `password_login`
- `magic_link_request`
- `magic_link_consume`
- `email_verification_request`
- `email_verification_consume`
- `password_reset_request`
- `password_reset_confirm`

`mode: "required"` rejects missing tokens before schema validation, account lookup, token lookup, token consume, or password hashing. `mode: "optional"` verifies tokens when present and skips verification when absent. Siteverify transport errors and malformed responses are treated as failed challenges, not successful verification. Missing or mismatched strict context fields fail the challenge as well.

Tests in `tests/security-hardening.test.ts` cover required-mode ordering and verifier failures.
