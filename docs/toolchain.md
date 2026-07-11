# Toolchain

Cloudflare Auth pins the release toolchain so generated apps, examples, and
package artifacts are tested against one known set of versions.

| Tool or runtime                  | Supported version                                    |
| -------------------------------- | ---------------------------------------------------- |
| Node.js                          | `>=22.13.0`                                          |
| pnpm                             | `11.1.1`; generated projects require pnpm `>=11 <12` |
| TypeScript                       | `6.0.3`                                              |
| Wrangler                         | `4.110.0`                                            |
| Hono                             | `4.12.29`                                            |
| tsup                             | `8.5.1`                                              |
| Vitest                           | `4.1.10`                                             |
| Zod                              | `4.4.3`                                              |
| Changesets                       | `2.31.0`                                             |
| Workers compatibility date       | `2026-05-15`                                         |
| Workers compatibility date floor | `2024-09-23`                                         |

Run `pnpm version-matrix:check` after changing any of these versions. Update
this page, generated templates, examples, and `doctor` guidance in the same
change when a platform minimum changes.
