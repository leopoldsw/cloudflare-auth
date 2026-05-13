import { AuthCryptoError } from "@cf-auth/core";
import type { AuthEmailAdapter, SendAuthEmailInput } from "@cf-auth/worker";

export const emailCloudflarePackageName = "@cf-auth/email-cloudflare";

export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name?: string };
    attachments?: Array<{
      content: string | ArrayBuffer;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface AuthEmailTemplateResult {
  subject: string;
  text: string;
  html: string;
}

export interface CloudflareEmailOptions {
  binding?: string;
  from: string | { email: string; name: string };
  appName?: string;
  templates?: Partial<{
    magicLink(
      input: SendAuthEmailInput & { appName: string },
    ): AuthEmailTemplateResult;
    emailVerification(
      input: SendAuthEmailInput & { appName: string },
    ): AuthEmailTemplateResult;
    passwordReset(
      input: SendAuthEmailInput & { appName: string },
    ): AuthEmailTemplateResult;
  }>;
}

export function cloudflareEmail(
  options: CloudflareEmailOptions,
): AuthEmailAdapter {
  const bindingName = options.binding ?? "AUTH_EMAIL";
  const appName = options.appName ?? "Cloudflare Auth";
  async function send(
    kind: "magic" | "verify" | "reset",
    input: SendAuthEmailInput,
    runtimeEnv: unknown,
  ) {
    const env = runtimeEnv as Record<string, unknown>;
    const binding = env[bindingName] as SendEmailBinding | undefined;
    if (!binding?.send) {
      throw new AuthCryptoError(
        `Cloudflare Email binding ${bindingName} is missing`,
        "email_binding_missing",
      );
    }
    const templateInput = { ...input, appName };
    const template =
      kind === "magic"
        ? (options.templates?.magicLink?.(templateInput) ??
          defaultMagicLinkTemplate(templateInput))
        : kind === "verify"
          ? (options.templates?.emailVerification?.(templateInput) ??
            defaultEmailVerificationTemplate(templateInput))
          : (options.templates?.passwordReset?.(templateInput) ??
            defaultPasswordResetTemplate(templateInput));
    await binding.send({
      to: input.to,
      from: options.from,
      subject: template.subject,
      text: template.text,
      html: template.html,
      headers: { "X-CF-Auth-Email-Type": kind },
    });
  }
  return {
    kind: "cloudflare-email",
    sendMagicLink(input, runtime) {
      return send("magic", input, runtime.env);
    },
    sendEmailVerification(input, runtime) {
      return send("verify", input, runtime.env);
    },
    sendPasswordReset(input, runtime) {
      return send("reset", input, runtime.env);
    },
  };
}

export function defaultMagicLinkTemplate(
  input: SendAuthEmailInput & { appName: string },
): AuthEmailTemplateResult {
  return makeTemplate({
    subject: `Sign in to ${input.appName}`,
    title: `Sign in to ${input.appName}`,
    body: "Use this link to finish signing in.",
    action: "Sign in",
    input,
  });
}

export function defaultEmailVerificationTemplate(
  input: SendAuthEmailInput & { appName: string },
): AuthEmailTemplateResult {
  return makeTemplate({
    subject: `Verify your email for ${input.appName}`,
    title: `Verify your email for ${input.appName}`,
    body: "Use this link to verify your email address.",
    action: "Verify email",
    input,
  });
}

export function defaultPasswordResetTemplate(
  input: SendAuthEmailInput & { appName: string },
): AuthEmailTemplateResult {
  return makeTemplate({
    subject: `Reset your ${input.appName} password`,
    title: `Reset your ${input.appName} password`,
    body: "Use this link to reset your password.",
    action: "Reset password",
    input,
  });
}

function makeTemplate(input: {
  subject: string;
  title: string;
  body: string;
  action: string;
  input: SendAuthEmailInput & { appName: string };
}): AuthEmailTemplateResult {
  const expires = new Date(input.input.expiresAt).toISOString();
  const text = `${input.body}\n\n${input.input.url}\n\nThis link expires at ${expires}.`;
  const escapedUrl = escapeHtml(input.input.url);
  return {
    subject: input.subject,
    text,
    html: `<h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.body)}</p><p><a href="${escapedUrl}">${escapeHtml(input.action)}</a></p><p>This link expires at ${escapeHtml(expires)}.</p>`,
  };
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
