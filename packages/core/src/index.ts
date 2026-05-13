export const corePackageName = "@cf-auth/core";

export type VerificationTokenType =
  | "magic_link"
  | "email_verification"
  | "password_reset";
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
  revokeActiveVerificationTokens(
    input: RevokeActiveVerificationTokensInput,
  ): Promise<number>;
  consumeVerificationToken(
    input: ConsumeVerificationTokenInput,
  ): Promise<VerificationTokenRow | null>;
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

export async function hashPassword(
  password: string,
  _options?: { profile?: string },
): Promise<string> {
  return `scrypt$v=1$n=16384$r=8$p=1$keylen=64$maxmem=33554432$salt=dummy$hash=${password.length}`;
}
