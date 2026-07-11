import { randomId, type UserRow } from "@cf-auth/core";
import {
  createAuthHandler,
  getAuthSessionFromRequest,
  getUser as getWorkerUser,
  type AuthHelperConfig,
  type PublicAuthUser,
} from "@cf-auth/worker";
import { Hono, type Context, type MiddlewareHandler } from "hono";

export const honoPackageName = "@cf-auth/hono";

const authUserKey = "cfAuthUser";
let defaultAuthConfig: AuthHelperConfig | null = null;

export function createAuthRoutes(config: AuthHelperConfig) {
  defaultAuthConfig = config;
  const app = new Hono();
  const handler = createAuthHandler(config);
  app.all("*", async (c) => {
    const request = withMountedBasePath(c.req.raw, config.basePath);
    const response = await handler.fetch(request, c.env, executionContext(c));
    return response ?? new Response("Not found", { status: 404 });
  });
  return app;
}

export function getAuthUser(c: Context): PublicAuthUser | null {
  return (c.get(authUserKey) as PublicAuthUser | null | undefined) ?? null;
}

export function optionalUser(config?: AuthHelperConfig): MiddlewareHandler {
  return async (c, next) => {
    const resolvedConfig = resolveHelperConfig(config);
    const user = await getWorkerUser(
      c.req.raw,
      c.env,
      executionContext(c),
      resolvedConfig,
    );
    c.set(authUserKey, user);
    await next();
  };
}

export function requireUser(config?: AuthHelperConfig): MiddlewareHandler {
  return async (c, next) => {
    const resolvedConfig = resolveHelperConfig(config);
    const user = await getWorkerUser(
      c.req.raw,
      c.env,
      executionContext(c),
      resolvedConfig,
    );
    if (!user)
      return c.json(
        authErrorBody(c.req.raw, "unauthorized", "Authentication required"),
        401,
      );
    c.set(authUserKey, user);
    await next();
  };
}

export function requireVerifiedUser(
  config?: AuthHelperConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const resolvedConfig = resolveHelperConfig(config);
    const session = await getAuthSessionFromRequest(
      resolvedConfig,
      c.req.raw,
      c.env,
      executionContext(c),
    );
    if (!session)
      return c.json(
        authErrorBody(c.req.raw, "unauthorized", "Authentication required"),
        401,
      );
    if (session.user.email_verified_at === null) {
      return c.json(
        authErrorBody(
          c.req.raw,
          "email_verification_required",
          "Email verification required",
        ),
        403,
      );
    }
    c.set(authUserKey, publicAuthUser(session.user));
    await next();
  };
}

function authErrorBody(request: Request, code: string, message: string) {
  return {
    error: { code, message },
    requestId: request.headers.get("CF-Ray") ?? randomId("req_"),
  };
}

function publicAuthUser(user: UserRow): PublicAuthUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    emailVerified: user.email_verified_at !== null,
    createdAt: user.created_at,
  };
}

function resolveHelperConfig(config?: AuthHelperConfig): AuthHelperConfig {
  const resolved = config ?? defaultAuthConfig;
  if (!resolved) {
    throw new Error(
      "createAuthRoutes(config) must be called before auth helper middleware without an explicit config",
    );
  }
  return resolved;
}

function withMountedBasePath(request: Request, basePath: string): Request {
  const url = new URL(request.url);
  if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
    return request;
  }
  url.pathname = `${basePath}${url.pathname === "/" ? "" : url.pathname}`;
  return new Request(url, request);
}

function executionContext(c: Context): ExecutionContext {
  try {
    return c.executionCtx as unknown as ExecutionContext;
  } catch {
    return { waitUntil() {} } as unknown as ExecutionContext;
  }
}
