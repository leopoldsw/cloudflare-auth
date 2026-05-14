export const clientPackageName = "@cf-auth/client";

export interface AuthClientOptions {
  basePath?: string;
  fetch?: typeof fetch;
}

export interface PublicAuthUser {
  id: string;
  email: string;
  username: string | null;
  emailVerified: boolean;
  createdAt: number;
}

export interface TurnstileClientInput {
  turnstileToken?: string;
}

export class AuthClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthClientError";
  }
}

export function createAuthClient(options: AuthClientOptions = {}) {
  const basePath = options.basePath ?? "/auth";
  const fetcher = options.fetch ?? fetch;
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${basePath}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
    const text = await response.text();
    const { payload, parsed } = parseResponsePayload(text);
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } })
        .error;
      throw new AuthClientError(
        error?.code ?? "request_failed",
        error?.message ?? "Request failed",
        response.status,
      );
    }
    if (!parsed) {
      throw new AuthClientError(
        "invalid_response",
        "Invalid JSON response",
        response.status,
      );
    }
    return payload as T;
  }
  return {
    signUp(
      input: {
        email: string;
        username?: string;
        password: string;
      } & TurnstileClientInput,
    ) {
      return request<{ user?: PublicAuthUser; ok?: true }>("/signup", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    signInWithPassword(
      input: { identifier: string; password: string } & TurnstileClientInput,
    ) {
      return request<{ user: PublicAuthUser }>("/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    signInWithMagicLink(
      input: { email: string; redirectTo?: string } & TurnstileClientInput,
    ) {
      return request<{ ok: true }>("/magic-link/request", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    consumeMagicLink(
      input: { token: string } & TurnstileClientInput,
    ): Promise<{ user: PublicAuthUser; redirectTo: string }> {
      return request("/magic-link/consume", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    signOut() {
      return request<{ ok: true }>("/logout", { method: "POST" });
    },
    getUser() {
      return request<{ user: PublicAuthUser | null }>("/user");
    },
    requestEmailVerification(
      input: { email: string; redirectTo?: string } & TurnstileClientInput,
    ) {
      return request<{ ok: true }>("/email/verify/request", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    verifyEmail(
      input: { token: string } & TurnstileClientInput,
    ): Promise<{ user: PublicAuthUser; redirectTo: string }> {
      return request("/email/verify/consume", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    requestPasswordReset(
      input: {
        email: string;
        afterResetRedirectTo?: string;
      } & TurnstileClientInput,
    ) {
      return request<{ ok: true }>("/password/reset/request", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    resetPassword(
      input: { token: string; password: string } & TurnstileClientInput,
    ) {
      return request<{ user: PublicAuthUser; redirectTo: string }>(
        "/password/reset/confirm",
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      );
    },
  };
}

function parseResponsePayload(text: string): {
  payload: unknown;
  parsed: boolean;
} {
  if (!text) return { payload: {}, parsed: true };
  try {
    return { payload: JSON.parse(text) as unknown, parsed: true };
  } catch {
    return { payload: {}, parsed: false };
  }
}
