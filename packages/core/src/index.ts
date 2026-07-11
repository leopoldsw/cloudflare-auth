import {
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
export const corePackageName = "@cf-auth/core";

const sensitiveFieldNamePattern = String.raw`(?:password(?:[_-]?hash)?|secret(?:[_-]?material)?|cookie|authorization|api[_-]?key|auth[_-]?token|session[_-]?token|(?:raw[_-]?)?token(?:[_-]?hash)?|AUTH_SECRET|AUTH_SECRET_PREVIOUS|(?:normalized[_-]?)?email|(?:normalized[_-]?)?identifier|(?:normalized[_-]?)?username|user[_-]?agent)`;
const sensitiveFieldBoundaryPattern = String.raw`(?:${sensitiveFieldNamePattern}|CF-Connecting-IP|remote[_-]?ip|client[_-]?ip)`;
const sensitiveColonFieldPattern = new RegExp(
  String.raw`(^|[\s,;&])(${sensitiveFieldNamePattern}:\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;&]*?)(?=\s+${sensitiveFieldBoundaryPattern}\s*[:=]|[\r\n,;&]|$)`,
  "giu",
);

export function redactLogValue(value: string): string {
  const redacted = value
    .replace(
      /\bhttps?:\/\/[^\s"'<>;,]*[?&]token=[^\s"'<>;,]*/giu,
      "[REDACTED_TOKEN_URL]",
    )
    .replace(
      /("[A-Za-z0-9_-]*(?:password(?:[_-]?hash)?|secret(?:[_-]?material)?|cookie|authorization|api[_-]?key|auth[_-]?token|session[_-]?token|(?:raw[_-]?)?token(?:[_-]?hash)?|(?:normalized[_-]?)?email|(?:normalized[_-]?)?identifier|(?:normalized[_-]?)?username|user[_-]?agent)"\s*:\s*)"[^"]*"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b((?:user[_-]?agent)=)(?:"[^"]*"|'[^']*'|[^\r\n,;&]+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:(?:normalized[_-]?)?email|(?:normalized[_-]?)?identifier|(?:normalized[_-]?)?username)=)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:password(?:[_-]?hash)?|secret(?:[_-]?material)?|cookie|authorization|api[_-]?key|auth[_-]?token|session[_-]?token|(?:raw[_-]?)?token(?:[_-]?hash)?|AUTH_SECRET|AUTH_SECRET_PREVIOUS)=)[^\s,;&"']+/giu,
      "$1[REDACTED]",
    )
    .replace(sensitiveColonFieldPattern, "$1$2[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(
      /\b((?:__Host-|__Secure-)?cfauth-session=)[^\s;,]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /hmac-sha256\$v=1\$kid=[A-Za-z0-9_-]{1,32}\$purpose=(?:session|magic_link|email_verification|password_reset)\$hash=[A-Za-z0-9_-]{43}/gu,
      "[REDACTED_TOKEN_HASH]",
    )
    .replace(
      /scrypt\$v=1\$n=\d+\$r=\d+\$p=\d+\$keylen=\d+\$maxmem=\d+\$salt=[A-Za-z0-9_-]+\$hash=[A-Za-z0-9_-]+/gu,
      "[REDACTED_PASSWORD_HASH]",
    )
    .replace(
      /cfauth\.(ses|magic|verify|reset)\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[REDACTED_EMAIL]",
    );
  return redactIpLiterals(redacted);
}

function redactIpLiterals(value: string): string {
  return value
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[REDACTED_IP]")
    .replace(
      /\[?(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.%]+\]?/gu,
      (candidate) => {
        const unwrapped =
          candidate.startsWith("[") && candidate.endsWith("]")
            ? candidate.slice(1, -1)
            : candidate;
        const withoutZone = unwrapped.split("%", 1)[0] ?? unwrapped;
        return isIP(withoutZone) === 6 ? "[REDACTED_IP]" : candidate;
      },
    );
}

export type VerificationTokenType =
  "magic_link" | "email_verification" | "password_reset";
export type ActiveTokenPolicy = "invalidate-previous" | "allow-multiple-active";

export interface UserRow {
  id: string;
  email: string;
  normalized_email: string;
  username: string | null;
  normalized_username: string | null;
  password_hash: string | null;
  email_verified_at: number | null;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
  metadata_json: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  user_agent_hash: string | null;
  ip_hash: string | null;
  metadata_json: string;
}

export interface SessionWithUserRow extends SessionRow {
  user: UserRow;
}

export interface VerificationTokenRow {
  id: string;
  user_id: string | null;
  normalized_email: string | null;
  token_hash: string;
  type: VerificationTokenType;
  redirect_to: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  consume_id: string | null;
  attempts: number;
  metadata_json: string;
}

export interface AuthEventRow {
  id: string;
  user_id: string | null;
  event_type: string;
  created_at: number;
  ip_hash: string | null;
  user_agent_hash: string | null;
  request_id: string | null;
  metadata_json: string;
}

export interface RateLimitRow {
  action: string;
  key: string;
  count: number;
  reset_at: number;
  updated_at: number;
}

export interface CreateUserInput {
  id: string;
  email: string;
  normalizedEmail: string;
  username?: string | null;
  normalizedUsername?: string | null;
  passwordHash?: string | null;
  emailVerifiedAt?: number | null;
  createdAt: number;
  updatedAt?: number;
  disabledAt?: number | null;
  metadataJson?: string;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  userAgentHash?: string | null;
  ipHash?: string | null;
  metadataJson?: string;
}

export interface CreateVerificationTokenInput {
  id: string;
  userId?: string | null;
  normalizedEmail?: string | null;
  tokenHash: string;
  type: VerificationTokenType;
  redirectTo?: string | null;
  createdAt: number;
  expiresAt: number;
  metadataJson?: string;
}

export interface RevokeActiveVerificationTokensInput {
  type: VerificationTokenType;
  userId?: string | null;
  normalizedEmail?: string | null;
  revokedAt: number;
  revokedReason: string;
}

export interface ConsumeVerificationTokenInput {
  tokenHash: string;
  type: VerificationTokenType;
  consumeId: string;
  consumedAt: number;
  now: number;
}

export interface CreateSessionFromTokenInput {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  userAgentHash?: string | null;
  ipHash?: string | null;
  metadataJson?: string;
}

export interface TokenConsumeEventInput {
  id: string;
  eventType: string;
  createdAt: number;
  ipHash?: string | null;
  userAgentHash?: string | null;
  requestId?: string | null;
  metadataJson?: string;
}

export interface ConsumeMagicLinkAndCreateSessionInput extends Omit<
  ConsumeVerificationTokenInput,
  "type"
> {
  session: CreateSessionFromTokenInput;
  jitUser?: {
    id: string;
    createdAt: number;
  };
  event?: TokenConsumeEventInput;
}

export interface ConsumeEmailVerificationInput extends Omit<
  ConsumeVerificationTokenInput,
  "type"
> {
  verifiedAt: number;
  updatedAt: number;
  session?: CreateSessionFromTokenInput;
  event?: TokenConsumeEventInput;
}

export interface ConsumePasswordResetInput extends Omit<
  ConsumeVerificationTokenInput,
  "type"
> {
  passwordHash: string;
  updatedAt: number;
  markEmailVerifiedAt?: number | null;
  revokeExistingSessionsAt?: number | null;
  session?: CreateSessionFromTokenInput;
  event?: TokenConsumeEventInput;
}

export interface ConsumeAuthFlowResult {
  token: VerificationTokenRow;
  user: UserRow;
  session?: SessionRow;
  redirectTo: string | null;
  createdUser?: boolean;
  revokedSessions?: number;
}

export interface WriteAuthEventInput {
  id: string;
  userId?: string | null;
  eventType: string;
  createdAt: number;
  ipHash?: string | null;
  userAgentHash?: string | null;
  requestId?: string | null;
  metadataJson?: string;
}

export interface FixedWindowHitInput {
  key: string;
  action: string;
  windowMs: number;
  limit: number;
  now: number;
}

export interface UserRepository {
  createUser(input: CreateUserInput): Promise<UserRow>;
  findUserById(id: string): Promise<UserRow | null>;
  findUserByNormalizedEmail(normalizedEmail: string): Promise<UserRow | null>;
  findUserByNormalizedUsername(
    normalizedUsername: string,
  ): Promise<UserRow | null>;
  updatePasswordHash(
    userId: string,
    passwordHash: string,
    now: number,
  ): Promise<void>;
  markEmailVerified(userId: string, verifiedAt: number): Promise<void>;
  setUserDisabled(userId: string, disabledAt: number | null): Promise<void>;
  updateUserMetadata(userId: string, metadataJson: string): Promise<void>;
}

export interface SessionRepository {
  createSession(input: CreateSessionInput): Promise<SessionRow>;
  findSessionByTokenHash(
    tokenHash: string,
    now: number,
  ): Promise<SessionWithUserRow | null>;
  touchSession(sessionId: string, now: number): Promise<void>;
  revokeSession(sessionId: string, now: number): Promise<void>;
  revokeSessionByTokenHash(tokenHash: string, now: number): Promise<void>;
  revokeAllUserSessions(userId: string, now: number): Promise<void>;
  deleteExpiredSessions(now: number): Promise<number>;
}

export interface VerificationTokenRepository {
  createVerificationToken(
    input: CreateVerificationTokenInput,
  ): Promise<VerificationTokenRow>;
  findActiveVerificationTokenByHash(
    tokenHash: string,
    type: VerificationTokenType,
    now: number,
  ): Promise<VerificationTokenRow | null>;
  findActiveDisabledUserByTokenHash(
    tokenHash: string,
    type: VerificationTokenType,
    now: number,
  ): Promise<UserRow | null>;
  revokeActiveVerificationTokens(
    input: RevokeActiveVerificationTokensInput,
  ): Promise<number>;
  consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationTokenRow | null>;
  consumeMagicLinkAndCreateSession(
    input: ConsumeMagicLinkAndCreateSessionInput,
  ): Promise<ConsumeAuthFlowResult | null>;
  consumeEmailVerification(
    input: ConsumeEmailVerificationInput,
  ): Promise<ConsumeAuthFlowResult | null>;
  consumePasswordReset(
    input: ConsumePasswordResetInput,
  ): Promise<ConsumeAuthFlowResult | null>;
  incrementTokenAttempts(tokenId: string): Promise<void>;
  deleteExpiredVerificationTokens(now: number): Promise<number>;
}

export interface EventRepository {
  writeAuthEvent(input: WriteAuthEventInput): Promise<void>;
  listRecentAuthEvents(userId: string, limit: number): Promise<AuthEventRow[]>;
}

export interface RateLimitRepository {
  hitFixedWindow(
    input: FixedWindowHitInput,
  ): Promise<{ allowed: boolean; count: number; resetAt: number }>;
  deleteExpiredRateLimitRows(now: number): Promise<number>;
}

export interface AuthRepositories {
  users: UserRepository;
  sessions: SessionRepository;
  verificationTokens: VerificationTokenRepository;
  events: EventRepository;
  rateLimits: RateLimitRepository;
}

export class AuthRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthRepositoryError";
  }
}

export function assertValidMetadataJson(metadataJson = "{}"): string {
  try {
    const parsed = JSON.parse(metadataJson);
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== "object"
    ) {
      throw new Error("metadata must be a JSON object");
    }
    return metadataJson;
  } catch (error) {
    throw new AuthRepositoryError(
      error instanceof Error ? error.message : "metadata must be valid JSON",
      "invalid_metadata_json",
    );
  }
}

export function assertVerificationTokenSubject(input: {
  type: VerificationTokenType;
  userId?: string | null;
  normalizedEmail?: string | null;
}): void {
  const hasUser = input.userId != null;
  const hasEmail = input.normalizedEmail != null;
  if (input.type === "email_verification" || input.type === "password_reset") {
    if (!hasUser || hasEmail) {
      throw new AuthRepositoryError(
        "verification token type requires a user subject",
        "invalid_token_subject",
      );
    }
    return;
  }
  if (input.type === "magic_link" && hasUser === hasEmail) {
    throw new AuthRepositoryError(
      "magic-link tokens require exactly one subject",
      "invalid_token_subject",
    );
  }
}

export function assertHmacTokenEnvelope(value: string): string {
  const pattern =
    /^hmac-sha256\$v=1\$kid=[A-Za-z0-9_-]{1,32}\$purpose=(session|magic_link|email_verification|password_reset)\$hash=[A-Za-z0-9_-]{43}$/;
  if (!pattern.test(value)) {
    throw new AuthRepositoryError(
      "token hash must be a v1 HMAC envelope",
      "invalid_token_hash",
    );
  }
  return value;
}

export function normalizeEmail(email: string): string {
  const trimmed = email.trim();
  if (
    trimmed.length > 320 ||
    !trimmed.includes("@") ||
    trimmed.split("@").length !== 2 ||
    /[\s\p{C}]/u.test(trimmed)
  ) {
    throw new AuthCryptoError("invalid email", "invalid_email");
  }
  const [local, domain] = trimmed.split("@");
  if (
    !local ||
    !domain ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    throw new AuthCryptoError("invalid email", "invalid_email");
  }
  for (const label of domain.split(".")) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label)) {
      throw new AuthCryptoError("invalid email", "invalid_email");
    }
  }
  return trimmed.toLowerCase();
}

const reservedUsernames = new Set([
  "admin",
  "root",
  "support",
  "auth",
  "api",
  "login",
  "logout",
  "signup",
  "me",
  "settings",
  "password",
  "reset",
  "verify",
  "email",
  "dev",
  "emails",
  "user",
  "users",
  "session",
  "sessions",
]);

export function normalizeUsername(
  username: string,
  options: { minLength?: number; maxLength?: number } = {},
): string {
  const minLength = options.minLength ?? 3;
  const maxLength = options.maxLength ?? 32;
  if (
    !Number.isInteger(minLength) ||
    minLength < 1 ||
    !Number.isInteger(maxLength) ||
    maxLength < minLength
  ) {
    throw new AuthCryptoError("invalid username policy", "invalid_username");
  }
  const normalized = username.trim().toLowerCase();
  if (
    normalized.length < minLength ||
    normalized.length > maxLength ||
    normalized.includes("@") ||
    !/^[a-z0-9_-]+$/u.test(normalized) ||
    reservedUsernames.has(normalized)
  ) {
    throw new AuthCryptoError("invalid username", "invalid_username");
  }
  return normalized;
}

export function validateRedirectTarget(input: {
  redirectTo: string | null | undefined;
  requestOrigin: string;
  allowedOrigins?: string[];
  defaultRedirect: string;
}): string {
  const value = input.redirectTo?.trim();
  if (!value) return input.defaultRedirect;
  if (/[\u0000-\u001F\u007F]/u.test(value) || /\\/u.test(value)) {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  if (
    decoded.includes("\\") ||
    decoded.startsWith("//") ||
    /^[/\\]%2f/i.test(value)
  ) {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  if (value.startsWith("/")) {
    if (!value.startsWith("/") || value.startsWith("//")) {
      throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
    }
    return (
      new URL(value, input.requestOrigin).pathname +
      new URL(value, input.requestOrigin).search +
      new URL(value, input.requestOrigin).hash
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  const allowed = new Set(input.allowedOrigins ?? []);
  if (!allowed.has(url.origin)) {
    throw new AuthCryptoError("unsafe redirect", "unsafe_redirect");
  }
  return `${url.origin}${url.pathname}${url.search}${url.hash}`;
}

export type AuthTokenPurpose = "ses" | "magic" | "verify" | "reset";
export type TokenHashPurpose =
  "session" | "magic_link" | "email_verification" | "password_reset";
export type HkdfPurpose =
  | "session-token-hmac"
  | "email-token-hmac"
  | "rate-limit-key-hmac"
  | "event-ip-hash"
  | "event-user-agent-hash"
  | "internal-state-signing";

export interface AuthSecret {
  kid: string;
  material: Buffer;
}

export interface AuthKeyRing {
  current: AuthSecret;
  previous: AuthSecret[];
}

export interface ParsedRawAuthToken {
  raw: string;
  purpose: AuthTokenPurpose;
  hashPurpose: TokenHashPurpose;
  kid: string;
  random: string;
}

export interface ParsedTokenHashEnvelope {
  algorithm: "hmac-sha256";
  version: 1;
  kid: string;
  purpose: TokenHashPurpose;
  hash: string;
}

export interface PasswordHashParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
  maxmem: number;
}

export interface ParsedPasswordHashEnvelope extends PasswordHashParams {
  algorithm: "scrypt";
  version: 1;
  salt: Buffer;
  hash: Buffer;
}

export type PasswordHashProfileName =
  "development-fast" | "workers-balanced" | "high-cost";

export interface PasswordHashOptions {
  profile?: PasswordHashProfileName;
  params?: Partial<PasswordHashParams>;
  saltBytes?: number;
}

export interface PasswordValidationResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export class AuthCryptoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthCryptoError";
  }
}

export const passwordHashProfiles: Record<
  PasswordHashProfileName,
  PasswordHashParams
> = {
  "development-fast": {
    N: 16_384,
    r: 8,
    p: 1,
    keyLen: 64,
    maxmem: 32 * 1024 * 1024,
  },
  "workers-balanced": {
    N: 32_768,
    r: 8,
    p: 1,
    keyLen: 64,
    maxmem: 64 * 1024 * 1024,
  },
  "high-cost": {
    N: 65_536,
    r: 8,
    p: 1,
    keyLen: 64,
    maxmem: 96 * 1024 * 1024,
  },
};

const tokenPattern =
  /^cfauth\.(ses|magic|verify|reset)\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{43})$/;

const tokenPurposeMap: Record<AuthTokenPurpose, TokenHashPurpose> = {
  ses: "session",
  magic: "magic_link",
  verify: "email_verification",
  reset: "password_reset",
};

const hashPurposeToHkdfPurpose: Record<TokenHashPurpose, HkdfPurpose> = {
  session: "session-token-hmac",
  magic_link: "email-token-hmac",
  email_verification: "email-token-hmac",
  password_reset: "email-token-hmac",
};

export function base64urlEncode(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64urlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new AuthCryptoError("invalid base64url input", "invalid_base64url");
  }
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(
    padded.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
}

export function randomId(prefix: string, bytes = 16): string {
  if (!/^[a-z][a-z0-9]*_$/u.test(prefix)) {
    throw new AuthCryptoError(
      "id prefix must be lowercase and end with underscore",
      "invalid_id_prefix",
    );
  }
  return `${prefix}${base64urlEncode(randomBytes(bytes))}`;
}

export function parseAuthSecret(secret: string): AuthSecret {
  const match = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)$/u.exec(secret);
  if (!match) {
    throw new AuthCryptoError(
      "AUTH_SECRET must be <kid>.<base64url>",
      "invalid_auth_secret",
    );
  }
  const kid = match[1];
  const encoded = match[2];
  if (!kid || !encoded) {
    throw new AuthCryptoError(
      "AUTH_SECRET must be <kid>.<base64url>",
      "invalid_auth_secret",
    );
  }
  const material = base64urlDecode(encoded);
  if (material.length < 32) {
    throw new AuthCryptoError(
      "AUTH_SECRET material must decode to at least 32 bytes",
      "weak_auth_secret",
    );
  }
  return { kid, material };
}

export function parseAuthKeyRing(
  current: string,
  previous?: string,
): AuthKeyRing {
  const currentSecret = parseAuthSecret(current);
  const previousSecrets =
    previous
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(parseAuthSecret) ?? [];
  const seen = new Set<string>();
  for (const secret of [currentSecret, ...previousSecrets]) {
    if (seen.has(secret.kid)) {
      throw new AuthCryptoError(
        `duplicate auth-secret kid: ${secret.kid}`,
        "duplicate_kid",
      );
    }
    seen.add(secret.kid);
  }
  return { current: currentSecret, previous: previousSecrets };
}

export function findAuthSecretByKid(
  keyRing: AuthKeyRing,
  kid: string,
): AuthSecret | null {
  if (keyRing.current.kid === kid) return keyRing.current;
  return keyRing.previous.find((secret) => secret.kid === kid) ?? null;
}

export function deriveSubkey(secret: AuthSecret, purpose: HkdfPurpose): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret.material, "cf-auth:v1", purpose, 32),
  );
}

export function generateRawAuthToken(
  purpose: AuthTokenPurpose,
  secret: AuthSecret,
): string {
  return `cfauth.${purpose}.${secret.kid}.${base64urlEncode(randomBytes(32))}`;
}

export function parseRawAuthToken(token: string): ParsedRawAuthToken {
  const match = tokenPattern.exec(token);
  if (!match) {
    throw new AuthCryptoError("malformed auth token", "malformed_token");
  }
  const [, purpose, kid, random] = match as unknown as [
    string,
    AuthTokenPurpose,
    string,
    string,
  ];
  return {
    raw: token,
    purpose,
    hashPurpose: tokenPurposeMap[purpose],
    kid,
    random,
  };
}

export function hashRawAuthToken(
  token: string,
  keyRing: AuthKeyRing,
  expectedPurpose?: TokenHashPurpose,
): string {
  const parsed = parseRawAuthToken(token);
  if (expectedPurpose && parsed.hashPurpose !== expectedPurpose) {
    throw new AuthCryptoError(
      "auth token has the wrong purpose",
      "wrong_token_purpose",
    );
  }
  const secret = findAuthSecretByKid(keyRing, parsed.kid);
  if (!secret) {
    throw new AuthCryptoError(
      "auth token kid is not in key ring",
      "unknown_kid",
    );
  }
  const key = deriveSubkey(
    secret,
    hashPurposeToHkdfPurpose[parsed.hashPurpose],
  );
  const hash = createHmac("sha256", key).update(token).digest();
  return `hmac-sha256$v=1$kid=${parsed.kid}$purpose=${parsed.hashPurpose}$hash=${base64urlEncode(hash)}`;
}

export function parseTokenHashEnvelope(value: string): ParsedTokenHashEnvelope {
  assertHmacTokenEnvelope(value);
  const [algorithm, versionField, kidField, purposeField, hashField] =
    value.split("$");
  const version = versionField === "v=1" ? 1 : null;
  const kid = kidField?.slice("kid=".length);
  const purpose = purposeField?.slice("purpose=".length) as TokenHashPurpose;
  const hash = hashField?.slice("hash=".length);
  if (
    algorithm !== "hmac-sha256" ||
    version !== 1 ||
    !kid ||
    !purpose ||
    !hash
  ) {
    throw new AuthCryptoError(
      "invalid token hash envelope",
      "invalid_token_hash",
    );
  }
  return { algorithm, version, kid, purpose, hash };
}

export function deriveRateLimitKey(input: {
  keyRing: AuthKeyRing;
  action: string;
  subjectType: "ip" | "email" | "identifier";
  subject: string;
}): string {
  const key = deriveSubkey(input.keyRing.current, "rate-limit-key-hmac");
  const message = `${input.action}\0${input.subjectType}\0${input.subject}`;
  const digest = base64urlEncode(
    createHmac("sha256", key).update(message).digest(),
  );
  return `rl:v1:${input.action}:${input.subjectType}:${digest}`;
}

export function canonicalizeIp(input: string | null | undefined): string {
  const value = input?.trim();
  if (!value) return "unknown";
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return compressIpv6(value);
  return "malformed";
}

export function canonicalizeUserAgent(
  input: string | null | undefined,
): string {
  return (input ?? "").trim().slice(0, 512);
}

export function deriveEventHash(input: {
  keyRing: AuthKeyRing;
  purpose: "event-ip-hash" | "event-user-agent-hash";
  value: string;
}): string {
  return base64urlEncode(
    createHmac("sha256", deriveSubkey(input.keyRing.current, input.purpose))
      .update(input.value)
      .digest(),
  );
}

export function validatePassword(password: string): PasswordValidationResult {
  if ([...password].length < 8) {
    return {
      ok: false,
      code: "password_too_short",
      message: "Password is too short",
    };
  }
  if ([...password].length > 128) {
    return {
      ok: false,
      code: "password_too_long",
      message: "Password is too long",
    };
  }
  if (Buffer.byteLength(password, "utf8") > 512) {
    return {
      ok: false,
      code: "password_too_large",
      message: "Password is too large",
    };
  }
  if (/^\s*$/u.test(password)) {
    return {
      ok: false,
      code: "password_all_whitespace",
      message: "Password must not be all whitespace",
    };
  }
  return { ok: true };
}

export function resolvePasswordHashParams(
  options: PasswordHashOptions = {},
): PasswordHashParams {
  const base = passwordHashProfiles[options.profile ?? "workers-balanced"];
  const params = { ...base, ...options.params };
  if (
    !Number.isInteger(params.N) ||
    params.N < 2 ||
    (params.N & (params.N - 1)) !== 0
  ) {
    throw new AuthCryptoError(
      "scrypt N must be a power of two",
      "invalid_scrypt_params",
    );
  }
  for (const key of ["r", "p", "keyLen", "maxmem"] as const) {
    if (!Number.isInteger(params[key]) || params[key] <= 0) {
      throw new AuthCryptoError(
        `scrypt ${key} must be positive`,
        "invalid_scrypt_params",
      );
    }
  }
  return params;
}

export async function hashPassword(
  password: string,
  options?: PasswordHashOptions,
): Promise<string> {
  const validation = validatePassword(password);
  if (!validation.ok) {
    throw new AuthCryptoError(
      validation.message ?? "invalid password",
      validation.code ?? "invalid_password",
    );
  }
  const params = resolvePasswordHashParams(options);
  const salt = randomBytes(options?.saltBytes ?? 16);
  const hash = await scryptWithParams(password, salt, params);
  return passwordEnvelope(params, salt, hash);
}

export function parsePasswordHashEnvelope(
  envelope: string,
): ParsedPasswordHashEnvelope {
  const parts = envelope.split("$");
  if (parts.length !== 9 || parts[0] !== "scrypt" || parts[1] !== "v=1") {
    throw new AuthCryptoError(
      "invalid password hash envelope",
      "invalid_password_hash",
    );
  }
  const values = Object.fromEntries(
    parts.slice(2).map((part) => part.split("=")),
  );
  const parsed: ParsedPasswordHashEnvelope = {
    algorithm: "scrypt",
    version: 1,
    N: Number(values.n),
    r: Number(values.r),
    p: Number(values.p),
    keyLen: Number(values.keylen),
    maxmem: Number(values.maxmem),
    salt: base64urlDecode(values.salt ?? ""),
    hash: base64urlDecode(values.hash ?? ""),
  };
  resolvePasswordHashParams({ params: parsed });
  if (parsed.salt.length < 16 || parsed.hash.length !== parsed.keyLen) {
    throw new AuthCryptoError(
      "invalid password hash envelope",
      "invalid_password_hash",
    );
  }
  return parsed;
}

export async function verifyPassword(
  password: string,
  envelope: string,
): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > 512) return false;
  const parsed = parsePasswordHashEnvelope(envelope);
  const hash = await scryptWithParams(password, parsed.salt, parsed);
  return safeEqual(hash, parsed.hash);
}

export function needsRehash(
  envelope: string,
  options?: PasswordHashOptions,
): boolean {
  const parsed = parsePasswordHashEnvelope(envelope);
  const current = resolvePasswordHashParams(options);
  return (
    parsed.N < current.N ||
    parsed.r < current.r ||
    parsed.p < current.p ||
    parsed.keyLen < current.keyLen ||
    parsed.maxmem < current.maxmem
  );
}

export async function dummyVerifyPassword(
  password: string,
  options?: PasswordHashOptions,
): Promise<boolean> {
  return verifyPassword(password, getDummyPasswordHash(options));
}

export function getDummyPasswordHash(options?: PasswordHashOptions): string {
  const params = resolvePasswordHashParams(options);
  const salt = Buffer.alloc(16, 7);
  const hash = Buffer.alloc(params.keyLen, 11);
  return passwordEnvelope(params, salt, hash);
}

export class PasswordHashSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent = 1,
    private readonly queueTimeoutMs = 2_000,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(
          new AuthCryptoError(
            "password hash queue timeout",
            "hash_queue_timeout",
          ),
        );
      }, this.queueTimeoutMs);
      const start = () => {
        clearTimeout(timeout);
        this.active += 1;
        resolve();
      };
      this.queue.push(start);
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

export interface ResolvedSessionCookie {
  name: string;
  secure: boolean;
  sameSite: "Lax" | "Strict";
  path: "/";
  domain?: string;
}

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/u;
const cookieDomainLabelPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

export function assertValidSessionCookieName(name: string): string {
  if (!name || !cookieNamePattern.test(name)) {
    throw new AuthCryptoError(
      "invalid session cookie name",
      "invalid_cookie_config",
    );
  }
  return name;
}

export function assertValidSessionCookieDomain(domain: string): string {
  const trimmed = domain.trim();
  if (
    trimmed !== domain ||
    trimmed.length > 254 ||
    !trimmed.startsWith(".") ||
    trimmed.endsWith(".") ||
    /[\u0000-\u001F\u007F]/u.test(trimmed)
  ) {
    throw new AuthCryptoError(
      "invalid session cookie Domain",
      "invalid_cookie_config",
    );
  }
  const hostname = trimmed.slice(1).toLowerCase();
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    isIP(hostname) ||
    !/[a-z]/iu.test(hostname) ||
    labels.some((label) => !cookieDomainLabelPattern.test(label))
  ) {
    throw new AuthCryptoError(
      "invalid session cookie Domain",
      "invalid_cookie_config",
    );
  }
  return `.${hostname}`;
}

export function resolveSessionCookie(input: {
  mode: "development" | "preview" | "production";
  requestOrigin: string;
  cookieName?: "auto" | string;
  sameSite?: "lax" | "strict";
  domain?: string;
}): ResolvedSessionCookie {
  const origin = new URL(input.requestOrigin);
  const domain = input.domain
    ? assertValidSessionCookieDomain(input.domain)
    : undefined;
  const localHttp =
    input.mode === "development" &&
    origin.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(origin.hostname);
  const secure = !localHttp;
  if (
    input.sameSite !== undefined &&
    input.sameSite !== "lax" &&
    input.sameSite !== "strict"
  ) {
    throw new AuthCryptoError(
      "unsupported SameSite mode",
      "invalid_cookie_config",
    );
  }
  if (domain && !secure) {
    throw new AuthCryptoError(
      "session cookie Domain requires HTTPS",
      "invalid_cookie_config",
    );
  }
  if (domain) {
    const cookieDomainHost = domain.slice(1);
    if (
      origin.hostname !== cookieDomainHost &&
      !origin.hostname.endsWith(domain)
    ) {
      throw new AuthCryptoError(
        "session cookie Domain must match the request host",
        "invalid_cookie_config",
      );
    }
  }
  const sameSite = input.sameSite === "strict" ? "Strict" : "Lax";
  const name =
    input.cookieName !== undefined && input.cookieName !== "auto"
      ? input.cookieName
      : !secure
        ? "cfauth-session"
        : domain
          ? "__Secure-cfauth-session"
          : "__Host-cfauth-session";
  assertValidSessionCookieName(name);
  if (name.startsWith("__Host-") && (!secure || domain)) {
    throw new AuthCryptoError(
      "__Host- cookies require Secure and no Domain",
      "invalid_cookie_config",
    );
  }
  if (name.startsWith("__Secure-") && !secure) {
    throw new AuthCryptoError(
      "__Secure- cookies require Secure",
      "invalid_cookie_config",
    );
  }
  return {
    name,
    secure,
    sameSite,
    path: "/",
    ...(domain ? { domain } : {}),
  };
}

export function serializeSessionCookie(
  cookie: ResolvedSessionCookie,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${cookie.name}=${value}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${cookie.sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookie.secure) parts.push("Secure");
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
  return parts.join("; ");
}

export function serializeClearSessionCookie(
  cookie: ResolvedSessionCookie,
): string {
  return serializeSessionCookie(cookie, "", 0);
}

function passwordEnvelope(
  params: PasswordHashParams,
  salt: Buffer,
  hash: Buffer,
): string {
  return [
    "scrypt",
    "v=1",
    `n=${params.N}`,
    `r=${params.r}`,
    `p=${params.p}`,
    `keylen=${params.keyLen}`,
    `maxmem=${params.maxmem}`,
    `salt=${base64urlEncode(salt)}`,
    `hash=${base64urlEncode(hash)}`,
  ].join("$");
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    const padded = Buffer.alloc(Math.max(left.length, right.length));
    timingSafeEqual(padded, padded);
    return false;
  }
  return timingSafeEqual(left, right);
}

function scryptWithParams(
  password: string,
  salt: Buffer,
  params: PasswordHashParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

function compressIpv6(value: string): string {
  if (!isIP(value)) return "malformed";
  const lower = value.toLowerCase();
  const [head = "", tail = ""] = lower.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const groups = lower.includes("::")
    ? [
        ...headParts,
        ...Array.from({
          length: Math.max(0, 8 - headParts.length - tailParts.length),
        }).map(() => "0"),
        ...tailParts,
      ]
    : lower.split(":");
  const normalized = groups.map((part) => part.replace(/^0+/u, "") || "0");
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  for (let i = 0; i <= normalized.length; i += 1) {
    if (normalized[i] === "0") {
      if (currentStart === -1) currentStart = i;
      currentLength += 1;
      continue;
    }
    if (currentLength > bestLength && currentLength > 1) {
      bestStart = currentStart;
      bestLength = currentLength;
    }
    currentStart = -1;
    currentLength = 0;
  }
  if (bestStart === -1) return normalized.join(":");
  const before = normalized.slice(0, bestStart).join(":");
  const after = normalized.slice(bestStart + bestLength).join(":");
  if (!before && !after) return "::";
  if (!before) return `::${after}`;
  if (!after) return `${before}::`;
  return `${before}::${after}`;
}
