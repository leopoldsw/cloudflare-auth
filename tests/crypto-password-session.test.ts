import {
  AuthCryptoError,
  PasswordHashSemaphore,
  base64urlDecode,
  base64urlEncode,
  canonicalizeIp,
  canonicalizeUserAgent,
  deriveRateLimitKey,
  deriveSubkey,
  dummyVerifyPassword,
  generateRawAuthToken,
  hashPassword,
  hashRawAuthToken,
  needsRehash,
  normalizeEmail,
  normalizeUsername,
  parseAuthKeyRing,
  parsePasswordHashEnvelope,
  parseRawAuthToken,
  parseTokenHashEnvelope,
  resolveSessionCookie,
  serializeClearSessionCookie,
  serializeSessionCookie,
  validateRedirectTarget,
  validatePassword,
  verifyPassword,
} from "@cf-auth/core";
import { describe, expect, it } from "vitest";

const current = "k_1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const previous = "kid-old.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("crypto, passwords, tokens, and sessions", () => {
  it("round-trips base64url without padding", () => {
    const encoded = base64urlEncode(Buffer.from("hello?"));
    expect(encoded).toBe("aGVsbG8_");
    expect(base64urlDecode(encoded).toString("utf8")).toBe("hello?");
    expect(() => base64urlDecode("bad===")).toThrow(AuthCryptoError);
  });

  it("parses key rings and rejects duplicate kids", () => {
    const keyRing = parseAuthKeyRing(current, previous);
    expect(keyRing.current.kid).toBe("k_1");
    expect(keyRing.previous[0]?.kid).toBe("kid-old");
    expect(() => parseAuthKeyRing(current, current)).toThrow(/duplicate/);
  });

  it("derives deterministic purpose-separated HKDF subkeys", () => {
    const keyRing = parseAuthKeyRing(current);
    const a = deriveSubkey(keyRing.current, "session-token-hmac");
    const b = deriveSubkey(keyRing.current, "session-token-hmac");
    const c = deriveSubkey(keyRing.current, "email-token-hmac");
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("generates, parses, and HMACs raw tokens without delimiter ambiguity", () => {
    const keyRing = parseAuthKeyRing(current);
    const token = generateRawAuthToken("magic", keyRing.current);
    const parsed = parseRawAuthToken(token);
    expect(parsed).toMatchObject({
      purpose: "magic",
      kid: "k_1",
      hashPurpose: "magic_link",
    });
    expect(parsed.random).toHaveLength(43);

    const hashed = hashRawAuthToken(token, keyRing, "magic_link");
    expect(hashRawAuthToken(token, keyRing, "magic_link")).toBe(hashed);
    expect(parseTokenHashEnvelope(hashed)).toMatchObject({
      kid: "k_1",
      purpose: "magic_link",
    });
    expect(() => hashRawAuthToken(token, keyRing, "session")).toThrow(
      AuthCryptoError,
    );
    expect(() => parseRawAuthToken("cfauth.magic.k_1.extra.segment")).toThrow(
      AuthCryptoError,
    );
  });

  it("derives rate-limit keys with action and subject-type namespaces", () => {
    const keyRing = parseAuthKeyRing(current);
    const email = deriveRateLimitKey({
      keyRing,
      action: "password_login",
      subjectType: "email",
      subject: "same",
    });
    const ip = deriveRateLimitKey({
      keyRing,
      action: "password_login",
      subjectType: "ip",
      subject: "same",
    });
    const otherAction = deriveRateLimitKey({
      keyRing,
      action: "magic_link_request",
      subjectType: "email",
      subject: "same",
    });
    expect(email).not.toBe(ip);
    expect(email).not.toBe(otherAction);
    expect(email).toMatch(/^rl:v1:password_login:email:[A-Za-z0-9_-]{43}$/);
    expect(email).not.toContain("same");
  });

  it("normalizes email and username inputs with v1 rejection rules", () => {
    expect(normalizeEmail(" Person@Example.COM ")).toBe("person@example.com");
    expect(() => normalizeEmail("bad@@example.com")).toThrow(AuthCryptoError);
    expect(() => normalizeEmail("bad@example..com")).toThrow(AuthCryptoError);
    expect(() => normalizeEmail("bad@-example.com")).toThrow(AuthCryptoError);

    expect(normalizeUsername(" Person_123 ")).toBe("person_123");
    expect(() => normalizeUsername("me")).toThrow(AuthCryptoError);
    expect(() => normalizeUsername("admin")).toThrow(AuthCryptoError);
    expect(() => normalizeUsername("person@example.com")).toThrow(
      AuthCryptoError,
    );
  });

  it("validates redirects without accepting encoded protocol-relative variants", () => {
    const base = {
      requestOrigin: "https://app.example.com",
      defaultRedirect: "/dashboard",
      allowedOrigins: ["https://docs.example.com"],
    };
    expect(validateRedirectTarget({ ...base, redirectTo: "" })).toBe(
      "/dashboard",
    );
    expect(validateRedirectTarget({ ...base, redirectTo: "/inside?x=1" })).toBe(
      "/inside?x=1",
    );
    expect(
      validateRedirectTarget({
        ...base,
        redirectTo: "https://docs.example.com/welcome#top",
      }),
    ).toBe("https://docs.example.com/welcome#top");
    for (const redirectTo of [
      "//evil.example",
      "%2f%2fevil.example",
      "/%2fevil.example",
      "\\evil",
      "javascript:alert(1)",
      "https://evil.example",
    ]) {
      expect(() => validateRedirectTarget({ ...base, redirectTo })).toThrow(
        AuthCryptoError,
      );
    }
  });

  it("canonicalizes IPs and caps user-agent values before hashing", () => {
    expect(canonicalizeIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(canonicalizeIp("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe(
      "2001:db8::ff00:42:8329",
    );
    expect(canonicalizeIp("not an ip")).toBe("malformed");
    expect(canonicalizeIp(null)).toBe("unknown");
    expect(canonicalizeUserAgent(` ${"a".repeat(600)} `)).toHaveLength(512);
  });

  it("hashes and verifies password envelopes", async () => {
    expect(validatePassword("        ")).toMatchObject({
      ok: false,
      code: "password_all_whitespace",
    });
    await expect(
      hashPassword("short", { profile: "development-fast" }),
    ).rejects.toThrow(AuthCryptoError);

    const envelope = await hashPassword("correct horse battery staple", {
      profile: "development-fast",
    });
    const parsed = parsePasswordHashEnvelope(envelope);
    expect(parsed).toMatchObject({
      algorithm: "scrypt",
      version: 1,
      N: 16_384,
      r: 8,
      p: 1,
      keyLen: 64,
      maxmem: 32 * 1024 * 1024,
    });
    await expect(
      verifyPassword("correct horse battery staple", envelope),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("wrong horse battery staple", envelope),
    ).resolves.toBe(false);
    expect(needsRehash(envelope, { profile: "workers-balanced" })).toBe(true);
    await expect(
      dummyVerifyPassword("absent account password", {
        profile: "development-fast",
      }),
    ).resolves.toBe(false);
  });

  it("limits password hashing concurrency with a semaphore", async () => {
    const semaphore = new PasswordHashSemaphore(1, 25);
    let running = 0;
    let maxRunning = 0;
    await Promise.all([
      semaphore.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      }),
      semaphore.run(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        running -= 1;
      }),
    ]);
    expect(maxRunning).toBe(1);

    const busy = new PasswordHashSemaphore(1, 1);
    const first = busy.run(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    await expect(busy.run(async () => undefined)).rejects.toThrow(
      AuthCryptoError,
    );
    await first;
  });

  it("resolves cookie names and flags for dev, production, and cross-subdomain modes", () => {
    const dev = resolveSessionCookie({
      mode: "development",
      requestOrigin: "http://localhost:8787",
      cookieName: "auto",
    });
    expect(dev).toMatchObject({
      name: "cfauth-session",
      secure: false,
      sameSite: "Lax",
    });
    expect(serializeSessionCookie(dev, "raw", 60)).not.toContain("__Host-");

    const prod = resolveSessionCookie({
      mode: "production",
      requestOrigin: "https://example.com",
      cookieName: "auto",
    });
    expect(prod).toMatchObject({ name: "__Host-cfauth-session", secure: true });
    expect(serializeSessionCookie(prod, "raw", 60)).toContain("Secure");
    expect(serializeClearSessionCookie(prod)).toContain("Max-Age=0");

    const cross = resolveSessionCookie({
      mode: "production",
      requestOrigin: "https://app.example.com",
      cookieName: "auto",
      domain: ".example.com",
    });
    expect(cross).toMatchObject({
      name: "__Secure-cfauth-session",
      secure: true,
      domain: ".example.com",
    });
  });
});
