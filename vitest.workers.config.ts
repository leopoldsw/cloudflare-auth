import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-05-14",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@cf-auth/client": `${root}packages/client/src/index.ts`,
      "@cf-auth/cli": `${root}packages/cli/src/index.ts`,
      "@cf-auth/core": `${root}packages/core/src/index.ts`,
      "@cf-auth/email-cloudflare": `${root}packages/email-cloudflare/src/index.ts`,
      "@cf-auth/hono": `${root}packages/hono/src/index.ts`,
      "@cf-auth/testing": `${root}packages/testing/src/index.ts`,
      "@cf-auth/worker": `${root}packages/worker/src/index.ts`,
      "cf-auth": `${root}packages/cf-auth-shim/src/index.ts`,
      "create-cloudflare-auth": `${root}packages/create-cloudflare-auth/src/index.ts`,
    },
  },
  test: {
    include: ["tests/workers-runtime.test.ts"],
  },
});
