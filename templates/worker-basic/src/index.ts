import {
  byEnvironment,
  createAuthHandler,
  defineAuthConfig,
  terminalEmail,
} from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

const authConfig = defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  passwordHashing: {
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
    queueTimeoutMs: 2000,
  },
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" },
    }),
    production: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" },
    }),
  }),
});
const authHandler = createAuthHandler(authConfig);

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const authResponse = await authHandler.fetch(request, env, ctx);
    if (authResponse) return authResponse;
    return new Response("Cloudflare Auth");
  },
};
