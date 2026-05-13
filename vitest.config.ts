import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    globals: true,
  },
});
