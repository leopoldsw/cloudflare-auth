import type { UserRow } from "@cf-auth/core";
import {
  createAuthHandler,
  getAuthSessionFromRequest,
  getUser as getWorkerUser,
  type AuthConfig,
  type MinimalAuthConfig,
  type PublicAuthUser,
} from "@cf-auth/worker";
import { Hono, type Context, type MiddlewareHandler } from "hono";

export const honoPackageName = "@cf-auth/hono";

const authUserKey = "cfAuthUser";
let defaultAuthConfig:
  | AuthConfig
  | (MinimalAuthConfig & Partial<AuthConfig>)
  | null = null;

export function createAuthRoutes(
  config: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
) {
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

export function optionalUser(
  config?: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
): MiddlewareHandler {
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

export function requireUser(
  config?: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
): MiddlewareHandler {
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
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    c.set(authUserKey, user);
    await next();
  };
}

export function requireVerifiedUser(
  config?: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
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
        { error: { code: "unauthorized", message: "Authentication required" } },
        401,
      );
    if (session.user.email_verified_at === null) {
      return c.json(
        {
          error: {
            code: "email_verification_required",
            message: "Email verification required",
          },
        },
        403,
      );
    }
    c.set(authUserKey, publicAuthUser(session.user));
    await next();
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

function resolveHelperConfig(
  config?: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
): AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>) {
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
    return c.executionCtx;
  } catch {
    return { waitUntil() {} } as unknown as ExecutionContext;
  }
}
