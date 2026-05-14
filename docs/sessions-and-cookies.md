# Sessions And Cookies

Sessions use opaque random tokens stored in HTTP-only cookies. D1 stores only HMAC hash envelopes.

Automatic cookie names:

| Mode                             | Cookie                    |
| -------------------------------- | ------------------------- |
| development HTTP localhost       | `cfauth-session`          |
| production host-only HTTPS       | `__Host-cfauth-session`   |
| production cross-subdomain HTTPS | `__Secure-cfauth-session` |
| preview HTTPS host-only          | `__Host-cfauth-session`   |

Logout revokes the session row and clears the cookie using the same name, path, domain, secure flag, and SameSite value.

Cross-subdomain cookies require explicit `session.domain` configuration using
a leading-dot parent domain such as `.example.com`. `Domain` values with
schemes, paths, wildcards, IP addresses, trailing dots, or header separators
are rejected, and the domain must match the request host or one of its parent
domains. Host-only production cookies keep the `__Host-` prefix and must not
configure `Domain`; cross-subdomain cookies use the `__Secure-` prefix and
require HTTPS.
