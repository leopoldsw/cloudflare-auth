import {
  type AuthEventRow,
  type AuthRepositories,
  AuthRepositoryError,
  type CreateSessionInput,
  type CreateUserInput,
  type CreateVerificationTokenInput,
  type EventRepository,
  type RateLimitRepository,
  type SessionRepository,
  type SessionRow,
  type SessionWithUserRow,
  type UserRepository,
  type UserRow,
  type VerificationTokenRepository,
  type VerificationTokenRow,
  assertHmacTokenEnvelope,
  assertValidMetadataJson,
  assertVerificationTokenSubject,
} from "@cf-auth/core";

export const workerPackageName = "@cf-auth/worker";

export interface MinimalAuthConfig {
  appName: string;
  basePath: string;
  email?: unknown;
}

type D1RunMeta = { changes?: number; last_row_id?: number };
type D1RunResult = { success?: boolean; meta?: D1RunMeta };

function changes(result: D1RunResult | undefined): number {
  return result?.meta?.changes ?? 0;
}

async function firstRequired<T>(statement: D1PreparedStatement): Promise<T> {
  const row = await statement.first<T>();
  if (!row) throw new AuthRepositoryError("expected one row", "row_not_found");
  return row;
}

function sessionWithUser(row: Record<string, unknown>): SessionWithUserRow {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    token_hash: row.token_hash as string,
    created_at: row.created_at as number,
    expires_at: row.expires_at as number,
    last_seen_at: (row.last_seen_at as number | null) ?? null,
    revoked_at: (row.revoked_at as number | null) ?? null,
    user_agent_hash: (row.user_agent_hash as string | null) ?? null,
    ip_hash: (row.ip_hash as string | null) ?? null,
    metadata_json: row.metadata_json as string,
    user: {
      id: row.u_id as string,
      email: row.email as string,
      normalized_email: row.normalized_email as string,
      username: (row.username as string | null) ?? null,
      normalized_username: (row.normalized_username as string | null) ?? null,
      password_hash: (row.password_hash as string | null) ?? null,
      email_verified_at: (row.email_verified_at as number | null) ?? null,
      created_at: row.user_created_at as number,
      updated_at: row.updated_at as number,
      disabled_at: (row.disabled_at as number | null) ?? null,
      metadata_json: row.user_metadata_json as string,
    },
  };
}

export function createD1Repositories(db: D1Database): AuthRepositories {
  const users: UserRepository = {
    async createUser(input: CreateUserInput): Promise<UserRow> {
      const metadataJson = assertValidMetadataJson(input.metadataJson);
      await db
        .prepare(
          `INSERT INTO users (
            id, email, normalized_email, username, normalized_username,
            password_hash, email_verified_at, created_at, updated_at, disabled_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.email,
          input.normalizedEmail,
          input.username ?? null,
          input.normalizedUsername ?? null,
          input.passwordHash ?? null,
          input.emailVerifiedAt ?? null,
          input.createdAt,
          input.updatedAt ?? input.createdAt,
          input.disabledAt ?? null,
          metadataJson,
        )
        .run();
      return firstRequired<UserRow>(
        db.prepare("SELECT * FROM users WHERE id = ?").bind(input.id),
      );
    },
    findUserById(id: string) {
      return db
        .prepare("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .first<UserRow>();
    },
    findUserByNormalizedEmail(normalizedEmail: string) {
      return db
        .prepare("SELECT * FROM users WHERE normalized_email = ?")
        .bind(normalizedEmail)
        .first<UserRow>();
    },
    findUserByNormalizedUsername(normalizedUsername: string) {
      return db
        .prepare("SELECT * FROM users WHERE normalized_username = ?")
        .bind(normalizedUsername)
        .first<UserRow>();
    },
    async updatePasswordHash(
      userId: string,
      passwordHash: string,
      now: number,
    ) {
      await db
        .prepare(
          "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        )
        .bind(passwordHash, now, userId)
        .run();
    },
    async markEmailVerified(userId: string, verifiedAt: number) {
      await db
        .prepare(
          "UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?",
        )
        .bind(verifiedAt, verifiedAt, userId)
        .run();
    },
    async setUserDisabled(userId: string, disabledAt: number | null) {
      await db
        .prepare(
          "UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(disabledAt, Date.now(), userId)
        .run();
      if (disabledAt !== null) {
        await db
          .prepare(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          )
          .bind(disabledAt, userId)
          .run();
      }
    },
    async updateUserMetadata(userId: string, metadataJson: string) {
      await db
        .prepare(
          "UPDATE users SET metadata_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(assertValidMetadataJson(metadataJson), Date.now(), userId)
        .run();
    },
  };

  const sessions: SessionRepository = {
    async createSession(input: CreateSessionInput): Promise<SessionRow> {
      assertHmacTokenEnvelope(input.tokenHash);
      const metadataJson = assertValidMetadataJson(input.metadataJson);
      await db
        .prepare(
          `INSERT INTO sessions (
            id, user_id, token_hash, created_at, expires_at, user_agent_hash, ip_hash, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.userId,
          input.tokenHash,
          input.createdAt,
          input.expiresAt,
          input.userAgentHash ?? null,
          input.ipHash ?? null,
          metadataJson,
        )
        .run();
      return firstRequired<SessionRow>(
        db.prepare("SELECT * FROM sessions WHERE id = ?").bind(input.id),
      );
    },
    async findSessionByTokenHash(
      tokenHash: string,
      now: number,
    ): Promise<SessionWithUserRow | null> {
      assertHmacTokenEnvelope(tokenHash);
      const sessionDb =
        "withSession" in db ? db.withSession("first-primary") : db;
      const row = await sessionDb
        .prepare(
          `SELECT
            sessions.*,
            users.id AS u_id,
            users.email,
            users.normalized_email,
            users.username,
            users.normalized_username,
            users.password_hash,
            users.email_verified_at,
            users.created_at AS user_created_at,
            users.updated_at,
            users.disabled_at,
            users.metadata_json AS user_metadata_json
          FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ?
            AND sessions.expires_at > ?
            AND sessions.revoked_at IS NULL
            AND users.disabled_at IS NULL`,
        )
        .bind(tokenHash, now)
        .first<Record<string, unknown>>();
      return row ? sessionWithUser(row) : null;
    },
    async touchSession(sessionId: string, now: number) {
      await db
        .prepare(
          "UPDATE sessions SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
        )
        .bind(now, sessionId, now - 10 * 60 * 1000)
        .run();
    },
    async revokeSession(sessionId: string, now: number) {
      await db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId)
        .run();
    },
    async revokeSessionByTokenHash(tokenHash: string, now: number) {
      assertHmacTokenEnvelope(tokenHash);
      await db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .bind(now, tokenHash)
        .run();
    },
    async revokeAllUserSessions(userId: string, now: number) {
      await db
        .prepare(
          "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        )
        .bind(now, userId)
        .run();
    },
    async deleteExpiredSessions(now: number): Promise<number> {
      const result = await db
        .prepare("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now)
        .run();
      return changes(result);
    },
  };

  const verificationTokens: VerificationTokenRepository = {
    async createVerificationToken(
      input: CreateVerificationTokenInput,
    ): Promise<VerificationTokenRow> {
      assertVerificationTokenSubject(input);
      assertHmacTokenEnvelope(input.tokenHash);
      const metadataJson = assertValidMetadataJson(input.metadataJson);
      await db
        .prepare(
          `INSERT INTO verification_tokens (
            id, user_id, normalized_email, token_hash, type, redirect_to,
            created_at, expires_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.userId ?? null,
          input.normalizedEmail ?? null,
          input.tokenHash,
          input.type,
          input.redirectTo ?? null,
          input.createdAt,
          input.expiresAt,
          metadataJson,
        )
        .run();
      return firstRequired<VerificationTokenRow>(
        db
          .prepare("SELECT * FROM verification_tokens WHERE id = ?")
          .bind(input.id),
      );
    },
    async revokeActiveVerificationTokens(input) {
      assertVerificationTokenSubject(input);
      const subjectSql = input.userId
        ? "user_id = ? AND normalized_email IS NULL"
        : "normalized_email = ? AND user_id IS NULL";
      const result = await db
        .prepare(
          `UPDATE verification_tokens
          SET revoked_at = ?, revoked_reason = ?
          WHERE type = ?
            AND used_at IS NULL
            AND consume_id IS NULL
            AND revoked_at IS NULL
            AND ${subjectSql}`,
        )
        .bind(
          input.revokedAt,
          input.revokedReason,
          input.type,
          input.userId ?? input.normalizedEmail,
        )
        .run();
      return changes(result);
    },
    async consumeVerificationToken(input: {
      tokenHash: string;
      type: VerificationTokenRow["type"];
      consumeId: string;
      consumedAt: number;
      now: number;
    }): Promise<VerificationTokenRow | null> {
      assertHmacTokenEnvelope(input.tokenHash);
      const statements = [
        db
          .prepare(
            `UPDATE verification_tokens
             SET used_at = ?, consume_id = ?, attempts = attempts + 1
             WHERE token_hash = ?
               AND type = ?
               AND used_at IS NULL
               AND consume_id IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?`,
          )
          .bind(
            input.consumedAt,
            input.consumeId,
            input.tokenHash,
            input.type,
            input.now,
          ),
        db
          .prepare(
            "SELECT * FROM verification_tokens WHERE consume_id = ? AND type = ?",
          )
          .bind(input.consumeId, input.type),
      ];
      const [updateResult, selectResult] = (await db.batch(
        statements,
      )) as unknown as [D1RunResult, { results?: VerificationTokenRow[] }];
      if (changes(updateResult) !== 1) return null;
      return selectResult.results?.[0] ?? null;
    },
    async incrementTokenAttempts(tokenId: string) {
      await db
        .prepare(
          "UPDATE verification_tokens SET attempts = attempts + 1 WHERE id = ?",
        )
        .bind(tokenId)
        .run();
    },
    async deleteExpiredVerificationTokens(now: number): Promise<number> {
      const result = await db
        .prepare("DELETE FROM verification_tokens WHERE expires_at <= ?")
        .bind(now)
        .run();
      return changes(result);
    },
  };

  const events: EventRepository = {
    async writeAuthEvent(input) {
      await db
        .prepare(
          `INSERT INTO auth_events (
            id, user_id, event_type, created_at, ip_hash, user_agent_hash, request_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.userId ?? null,
          input.eventType,
          input.createdAt,
          input.ipHash ?? null,
          input.userAgentHash ?? null,
          input.requestId ?? null,
          assertValidMetadataJson(input.metadataJson),
        )
        .run();
    },
    async listRecentAuthEvents(
      userId: string,
      limit: number,
    ): Promise<AuthEventRow[]> {
      const result = await db
        .prepare(
          "SELECT * FROM auth_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .bind(userId, limit)
        .all<AuthEventRow>();
      return result.results ?? [];
    },
  };

  const rateLimits: RateLimitRepository = {
    async hitFixedWindow(
      input,
    ): Promise<{ allowed: boolean; count: number; resetAt: number }> {
      const resetAt = input.now + input.windowMs;
      const statements = [
        db
          .prepare(
            `INSERT INTO rate_limits (action, key, count, reset_at, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT(action, key) DO UPDATE SET
               count = CASE
                 WHEN rate_limits.reset_at <= excluded.updated_at THEN 1
                 ELSE rate_limits.count + 1
               END,
               reset_at = CASE
                 WHEN rate_limits.reset_at <= excluded.updated_at THEN excluded.reset_at
                 ELSE rate_limits.reset_at
               END,
               updated_at = excluded.updated_at`,
          )
          .bind(input.action, input.key, resetAt, input.now),
        db
          .prepare(
            "SELECT count, reset_at FROM rate_limits WHERE action = ? AND key = ?",
          )
          .bind(input.action, input.key),
      ];
      const [, selectResult] = (await db.batch(statements)) as unknown as [
        D1RunResult,
        { results?: Array<{ count: number; reset_at: number }> },
      ];
      const row = selectResult.results?.[0];
      if (!row)
        throw new AuthRepositoryError(
          "rate limit row missing after hit",
          "rate_limit_error",
        );
      return {
        allowed: row.count <= input.limit,
        count: row.count,
        resetAt: row.reset_at,
      };
    },
    async deleteExpiredRateLimitRows(now: number): Promise<number> {
      const result = await db
        .prepare("DELETE FROM rate_limits WHERE reset_at <= ?")
        .bind(now)
        .run();
      return changes(result);
    },
  };

  return { users, sessions, verificationTokens, events, rateLimits };
}

export function defineAuthConfig<T extends MinimalAuthConfig>(config: T): T {
  return config;
}

export function terminalEmail(options: { outbox?: boolean } = {}) {
  return { kind: "terminal", outbox: options.outbox === true };
}

export function createAuthHandler(config: MinimalAuthConfig) {
  return {
    async fetch(
      request: Request,
      _env?: unknown,
      _ctx?: ExecutionContext,
    ): Promise<Response | null> {
      const url = new URL(request.url);
      if (
        url.pathname === config.basePath ||
        url.pathname.startsWith(`${config.basePath}/`)
      ) {
        return Response.json({ ok: true, appName: config.appName });
      }
      return null;
    },
  };
}
