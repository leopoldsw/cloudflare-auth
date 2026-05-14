import {
  byEnvironment,
  createAuthHandler,
  defineAuthConfig,
  terminalEmail,
} from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

const authConfig = defineAuthConfig({
  appName: "Worker Basic",
  basePath: "/auth",
  passwordHashing: {
    profile: "development-fast",
    maxConcurrentHashesPerIsolate: 1,
  },
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "Worker Basic" },
    }),
    production: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "Worker Basic" },
    }),
  }),
});
const authHandler = createAuthHandler(authConfig);

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const authResponse = await authHandler.fetch(request, env, ctx);
    if (authResponse) return authResponse;
    return new Response(
      `<!doctype html>
<meta charset="utf-8">
<title>Cloudflare Auth Worker Example</title>
<main>
  <h1>Cloudflare Auth</h1>
  <form method="post" action="/auth/signup">
    <input name="email" type="email" placeholder="email@example.com">
    <input name="password" type="password" placeholder="Password">
    <button type="submit">Sign up</button>
  </form>
  <form method="post" action="/auth/login">
    <input name="identifier" placeholder="Email or username">
    <input name="password" type="password" placeholder="Password">
    <button type="submit">Sign in</button>
  </form>
</main>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
};
