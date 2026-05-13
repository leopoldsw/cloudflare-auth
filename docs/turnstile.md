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

Set `TURNSTILE_SECRET_KEY` as a Worker secret when using the built-in verifier. Clients submit the widget response as `turnstileToken` in JSON or form bodies.

Available endpoint names:

- `signup`
- `password_login`
- `magic_link_request`
- `magic_link_consume`
- `email_verification_request`
- `email_verification_consume`
- `password_reset_request`
- `password_reset_confirm`

`mode: "required"` rejects missing tokens before schema validation, account lookup, token lookup, token consume, or password hashing. `mode: "optional"` verifies tokens when present and skips verification when absent.

Tests in `tests/security-hardening.test.ts` cover required-mode ordering and verifier failures.
