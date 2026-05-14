# Metrics And Auth Events

Cloudflare Auth writes operational events to `auth_events` for core auth
outcomes. Event rows store HMAC hashes for IP and user-agent values and never
store raw emails, identifiers, passwords, tokens, cookies, IPs, or user agents.

Useful event types include:

- `signup_success`
- `signup_failed`
- `password_login_success`
- `password_login_failed`
- `dummy_password_verification`
- `magic_link_request`
- `magic_link_consume_success`
- `magic_link_consume_failed`
- `email_verification_request`
- `email_verification_consume_success`
- `email_verification_consume_failed`
- `password_reset_request`
- `password_reset_confirm_success`
- `password_reset_confirm_failed`
- `session_revoked`
- `disabled_user_auth_attempt`
- `rate_limit_hit`
- `email_send_failed`

Example aggregate query:

```sql
SELECT event_type, count(*) AS count
FROM auth_events
WHERE created_at >= unixepoch('now', '-1 day') * 1000
GROUP BY event_type
ORDER BY count DESC;
```

Recent rate-limit hits:

```sql
SELECT created_at, metadata_json
FROM auth_events
WHERE event_type = 'rate_limit_hit'
ORDER BY created_at DESC
LIMIT 50;
```

Failed token consumes:

```sql
SELECT event_type, count(*) AS count
FROM auth_events
WHERE event_type IN (
  'magic_link_consume_failed',
  'email_verification_consume_failed',
  'password_reset_confirm_failed'
)
GROUP BY event_type;
```

Keep `auth_events` according to your audit-retention policy. The generated
cleanup command keeps 90 days by default.
