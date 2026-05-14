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
</main>`),
);

export default app;
