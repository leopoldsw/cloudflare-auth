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
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
    queueTimeoutMs: 2000,
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
  <form id="signup">
    <input name="email" type="email" placeholder="email@example.com">
    <input name="password" type="password" placeholder="Password">
    <button type="submit">Sign up</button>
  </form>
  <form id="login">
    <input name="identifier" placeholder="Email or username">
    <input name="password" type="password" placeholder="Password">
    <button type="submit">Sign in</button>
  </form>
  <pre id="result" aria-live="polite"></pre>
</main>
<script type="module">
const result = document.querySelector("#result");
async function submit(path, form) {
  const body = Object.fromEntries(new FormData(form));
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  result.textContent = JSON.stringify(await response.json(), null, 2);
}
document.querySelector("#signup").addEventListener("submit", (event) => {
  event.preventDefault();
  submit("/auth/signup", event.currentTarget);
});
document.querySelector("#login").addEventListener("submit", (event) => {
  event.preventDefault();
  submit("/auth/login", event.currentTarget);
});
</script>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
};
