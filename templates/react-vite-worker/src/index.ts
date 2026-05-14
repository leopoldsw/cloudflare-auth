import { createAuthClient } from "@cf-auth/client";
import { createAuthRoutes } from "@cf-auth/hono";
import { Hono } from "hono";
import authConfig from "./auth.config.js";

export const auth = createAuthClient({ basePath: "/auth" });

const app = new Hono();

app.route(authConfig.basePath, createAuthRoutes(authConfig));
app.get("/", (c) => c.html("<h1>Cloudflare Auth</h1>"));

export default app;
