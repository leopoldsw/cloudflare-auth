import { cloudflareEmail } from "@cf-auth/email-cloudflare";
import {
  byEnvironment,
  defineAuthConfig,
  terminalEmail,
} from "@cf-auth/worker";

export default defineAuthConfig({
  appName: "React Vite Worker",
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
      from: { email: "auth@example.com", name: "React Vite Worker" },
    }),
    production: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "React Vite Worker" },
    }),
  }),
});
