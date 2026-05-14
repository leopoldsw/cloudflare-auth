import { Hono } from "hono";
import { createAuthRoutes } from "@cf-auth/hono";
import authConfig from "./auth.config.js";

const app = new Hono();

app.route(authConfig.basePath, createAuthRoutes(authConfig));
app.get("/", (c) =>
  c.html(`<!doctype html>
<meta charset="utf-8">
<title>Cloudflare Auth Hono Example</title>
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
</script>`),
);

export default app;
