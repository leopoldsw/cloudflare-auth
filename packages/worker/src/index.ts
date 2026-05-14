import {
  type ActiveTokenPolicy,
  type AuthEventRow,
  AuthCryptoError,
  type AuthRepositories,
  AuthRepositoryError,
  type ConsumeAuthFlowResult,
  type ConsumeEmailVerificationInput,
  type ConsumeMagicLinkAndCreateSessionInput,
  type ConsumePasswordResetInput,
  type CreateSessionInput,
  type CreateSessionFromTokenInput,
  type CreateUserInput,
  type CreateVerificationTokenInput,
  type EventRepository,
  type RateLimitRepository,
  type SessionRepository,
  type SessionRow,
  type SessionWithUserRow,
  type TokenConsumeEventInput,
  type UserRepository,
  type UserRow,
  type VerificationTokenRepository,
  type VerificationTokenRow,
  assertHmacTokenEnvelope,
  assertValidMetadataJson,
  assertValidSessionCookieDomain,
  assertValidSessionCookieName,
  assertVerificationTokenSubject,
  canonicalizeIp,
  canonicalizeUserAgent,
  deriveEventHash,
  deriveRateLimitKey,
  dummyVerifyPassword,
  generateRawAuthToken,
  hashPassword,
  hashRawAuthToken,
  normalizeEmail,
  normalizeUsername,
  parseAuthKeyRing,
  parseRawAuthToken,
  PasswordHashSemaphore,
  randomId,
  resolveSessionCookie,
  serializeClearSessionCookie,
  serializeSessionCookie,
  validatePassword,
  validateRedirectTarget,
  verifyPassword,
} from "@cf-auth/core";
import { z } from "zod";

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

function tokenFlowResult(
  token: VerificationTokenRow | undefined,
  user: UserRow | undefined,
  session?: SessionRow,
  extra: Pick<ConsumeAuthFlowResult, "createdUser" | "revokedSessions"> = {},
): ConsumeAuthFlowResult | null {
  if (!token || !user || user.disabled_at !== null) return null;
  const result: ConsumeAuthFlowResult = {
    token,
    user,
    redirectTo: token.redirect_to,
    ...extra,
  };
  if (session) result.session = session;
  return result;
}

function assertSessionFromToken(input: CreateSessionFromTokenInput): string {
  assertHmacTokenEnvelope(input.tokenHash);
  return assertValidMetadataJson(input.metadataJson);
}

function tokenEventStatement(
  db: D1Database,
  event: TokenConsumeEventInput | undefined,
  consumeId: string,
  type: VerificationTokenRow["type"],
): D1PreparedStatement | null {
  if (!event) return null;
  return db
    .prepare(
      `INSERT INTO auth_events (
        id, user_id, event_type, created_at, ip_hash, user_agent_hash, request_id, metadata_json
      )
      SELECT ?, user_id, ?, ?, ?, ?, ?, ?
      FROM verification_tokens
      WHERE consume_id = ? AND type = ? AND user_id IS NOT NULL`,
    )
    .bind(
      event.id,
      event.eventType,
      event.createdAt,
      event.ipHash ?? null,
      event.userAgentHash ?? null,
      event.requestId ?? null,
      assertValidMetadataJson(event.metadataJson),
      consumeId,
      type,
    );
}

function selectTokenByConsumeStatement(
  db: D1Database,
  consumeId: string,
  type: VerificationTokenRow["type"],
): D1PreparedStatement {
  return db
    .prepare(
      "SELECT * FROM verification_tokens WHERE consume_id = ? AND type = ?",
    )
    .bind(consumeId, type);
}

function selectUserByConsumedTokenStatement(
  db: D1Database,
  consumeId: string,
  type: VerificationTokenRow["type"],
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT users.*
      FROM users
      JOIN verification_tokens ON verification_tokens.user_id = users.id
      WHERE verification_tokens.consume_id = ?
        AND verification_tokens.type = ?`,
    )
    .bind(consumeId, type);
}

function selectSessionStatement(
  db: D1Database,
  session: CreateSessionFromTokenInput | undefined,
): D1PreparedStatement | null {
  if (!session) return null;
  return db.prepare("SELECT * FROM sessions WHERE id = ?").bind(session.id);
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
    async findActiveVerificationTokenByHash(tokenHash, type, now) {
      assertHmacTokenEnvelope(tokenHash);
      const sessionDb =
        "withSession" in db ? db.withSession("first-primary") : db;
      return sessionDb
        .prepare(
          `SELECT * FROM verification_tokens
           WHERE token_hash = ?
             AND type = ?
             AND used_at IS NULL
             AND consume_id IS NULL
             AND revoked_at IS NULL
             AND expires_at > ?
             AND (
               user_id IS NULL
               OR EXISTS (
                 SELECT 1 FROM users
                 WHERE users.id = verification_tokens.user_id
                   AND users.disabled_at IS NULL
               )
             )`,
        )
        .bind(tokenHash, type, now)
        .first<VerificationTokenRow>();
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
    async consumeMagicLinkAndCreateSession(
      input: ConsumeMagicLinkAndCreateSessionInput,
    ): Promise<ConsumeAuthFlowResult | null> {
      assertHmacTokenEnvelope(input.tokenHash);
      const sessionMetadataJson = assertSessionFromToken(input.session);
      const eventStatement = tokenEventStatement(
        db,
        input.event,
        input.consumeId,
        "magic_link",
      );

      if (input.jitUser) {
        const statements = [
          db
            .prepare(
              `UPDATE verification_tokens
               SET used_at = ?, consume_id = ?, attempts = attempts + 1
               WHERE token_hash = ?
                 AND type = 'magic_link'
                 AND used_at IS NULL
                 AND consume_id IS NULL
                 AND revoked_at IS NULL
                 AND expires_at > ?
                 AND user_id IS NULL
                 AND normalized_email IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM users
                   WHERE users.normalized_email = verification_tokens.normalized_email
                     AND users.disabled_at IS NOT NULL
                 )`,
            )
            .bind(
              input.consumedAt,
              input.consumeId,
              input.tokenHash,
              input.now,
            ),
          db
            .prepare(
              `INSERT OR IGNORE INTO users (
                id, email, normalized_email, username, normalized_username,
                password_hash, email_verified_at, created_at, updated_at, metadata_json
              )
              SELECT ?, normalized_email, normalized_email, NULL, NULL, NULL, ?, ?, ?, '{}'
              FROM verification_tokens
              WHERE consume_id = ? AND type = 'magic_link'`,
            )
            .bind(
              input.jitUser.id,
              input.consumedAt,
              input.jitUser.createdAt,
              input.jitUser.createdAt,
              input.consumeId,
            ),
          db
            .prepare(
              `UPDATE verification_tokens
               SET user_id = (
                   SELECT users.id
                   FROM users
                   WHERE users.normalized_email = verification_tokens.normalized_email
                     AND users.disabled_at IS NULL
                 ),
                 normalized_email = NULL
               WHERE consume_id = ?
                 AND type = 'magic_link'
                 AND user_id IS NULL
                 AND normalized_email IS NOT NULL`,
            )
            .bind(input.consumeId),
          db
            .prepare(
              `UPDATE users
               SET email_verified_at = COALESCE(email_verified_at, ?),
                   updated_at = ?
               WHERE id = (
                 SELECT user_id FROM verification_tokens
                 WHERE consume_id = ? AND type = 'magic_link'
               )`,
            )
            .bind(input.consumedAt, input.consumedAt, input.consumeId),
          db
            .prepare(
              `INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at,
                last_seen_at, revoked_at, user_agent_hash, ip_hash, metadata_json
              )
              SELECT ?, user_id, ?, ?, ?, NULL, NULL, ?, ?, ?
              FROM verification_tokens
              WHERE consume_id = ? AND type = 'magic_link' AND user_id IS NOT NULL`,
            )
            .bind(
              input.session.id,
              input.session.tokenHash,
              input.session.createdAt,
              input.session.expiresAt,
              input.session.userAgentHash ?? null,
              input.session.ipHash ?? null,
              sessionMetadataJson,
              input.consumeId,
            ),
          ...(eventStatement ? [eventStatement] : []),
          selectTokenByConsumeStatement(db, input.consumeId, "magic_link"),
          selectUserByConsumedTokenStatement(db, input.consumeId, "magic_link"),
          selectSessionStatement(db, input.session),
        ].filter(Boolean) as D1PreparedStatement[];
        const results = (await db.batch(statements)) as unknown as D1Result[];
        const eventOffset = eventStatement ? 1 : 0;
        if (changes(results[0]) !== 1) return null;
        if (changes(results[2]) !== 1 || changes(results[4]) !== 1) {
          throw new AuthRepositoryError(
            "magic link consume did not create required state",
            "token_consume_inconsistent",
          );
        }
        return tokenFlowResult(
          (results[5 + eventOffset]?.results as VerificationTokenRow[])?.[0],
          (results[6 + eventOffset]?.results as UserRow[])?.[0],
          (results[7 + eventOffset]?.results as SessionRow[])?.[0],
          { createdUser: changes(results[1]) === 1 },
        );
      }

      const statements = [
        db
          .prepare(
            `UPDATE verification_tokens
             SET used_at = ?, consume_id = ?, attempts = attempts + 1
             WHERE token_hash = ?
               AND type = 'magic_link'
               AND used_at IS NULL
               AND consume_id IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?
               AND user_id IS NOT NULL
               AND normalized_email IS NULL
               AND EXISTS (
                 SELECT 1 FROM users
                 WHERE users.id = verification_tokens.user_id
                   AND users.disabled_at IS NULL
               )`,
          )
          .bind(input.consumedAt, input.consumeId, input.tokenHash, input.now),
        db
          .prepare(
            `UPDATE users
             SET email_verified_at = COALESCE(email_verified_at, ?),
                 updated_at = ?
             WHERE id = (
               SELECT user_id FROM verification_tokens
               WHERE consume_id = ? AND type = 'magic_link'
             )`,
          )
          .bind(input.consumedAt, input.consumedAt, input.consumeId),
        db
          .prepare(
            `INSERT INTO sessions (
              id, user_id, token_hash, created_at, expires_at,
              last_seen_at, revoked_at, user_agent_hash, ip_hash, metadata_json
            )
            SELECT ?, user_id, ?, ?, ?, NULL, NULL, ?, ?, ?
            FROM verification_tokens
            WHERE consume_id = ? AND type = 'magic_link' AND user_id IS NOT NULL`,
          )
          .bind(
            input.session.id,
            input.session.tokenHash,
            input.session.createdAt,
            input.session.expiresAt,
            input.session.userAgentHash ?? null,
            input.session.ipHash ?? null,
            sessionMetadataJson,
            input.consumeId,
          ),
        ...(eventStatement ? [eventStatement] : []),
        selectTokenByConsumeStatement(db, input.consumeId, "magic_link"),
        selectUserByConsumedTokenStatement(db, input.consumeId, "magic_link"),
        selectSessionStatement(db, input.session),
      ].filter(Boolean) as D1PreparedStatement[];
      const results = (await db.batch(statements)) as unknown as D1Result[];
      const eventOffset = eventStatement ? 1 : 0;
      if (changes(results[0]) !== 1) return null;
      if (changes(results[1]) !== 1 || changes(results[2]) !== 1) {
        throw new AuthRepositoryError(
          "magic link consume did not create required state",
          "token_consume_inconsistent",
        );
      }
      return tokenFlowResult(
        (results[3 + eventOffset]?.results as VerificationTokenRow[])?.[0],
        (results[4 + eventOffset]?.results as UserRow[])?.[0],
        (results[5 + eventOffset]?.results as SessionRow[])?.[0],
        { createdUser: false },
      );
    },
    async consumeEmailVerification(
      input: ConsumeEmailVerificationInput,
    ): Promise<ConsumeAuthFlowResult | null> {
      assertHmacTokenEnvelope(input.tokenHash);
      const sessionMetadataJson = input.session
        ? assertSessionFromToken(input.session)
        : null;
      const eventStatement = tokenEventStatement(
        db,
        input.event,
        input.consumeId,
        "email_verification",
      );
      const sessionStatement = input.session
        ? db
            .prepare(
              `INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at,
                last_seen_at, revoked_at, user_agent_hash, ip_hash, metadata_json
              )
              SELECT ?, user_id, ?, ?, ?, NULL, NULL, ?, ?, ?
              FROM verification_tokens
              WHERE consume_id = ? AND type = 'email_verification' AND user_id IS NOT NULL`,
            )
            .bind(
              input.session.id,
              input.session.tokenHash,
              input.session.createdAt,
              input.session.expiresAt,
              input.session.userAgentHash ?? null,
              input.session.ipHash ?? null,
              sessionMetadataJson,
              input.consumeId,
            )
        : null;
      const statements = [
        db
          .prepare(
            `UPDATE verification_tokens
             SET used_at = ?, consume_id = ?, attempts = attempts + 1
             WHERE token_hash = ?
               AND type = 'email_verification'
               AND used_at IS NULL
               AND consume_id IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?
               AND user_id IS NOT NULL
               AND normalized_email IS NULL
               AND EXISTS (
                 SELECT 1 FROM users
                 WHERE users.id = verification_tokens.user_id
                   AND users.disabled_at IS NULL
               )`,
          )
          .bind(input.consumedAt, input.consumeId, input.tokenHash, input.now),
        db
          .prepare(
            `UPDATE users
             SET email_verified_at = COALESCE(email_verified_at, ?),
                 updated_at = ?
             WHERE id = (
               SELECT user_id FROM verification_tokens
               WHERE consume_id = ? AND type = 'email_verification'
             )`,
          )
          .bind(input.verifiedAt, input.updatedAt, input.consumeId),
        sessionStatement,
        eventStatement,
        selectTokenByConsumeStatement(
          db,
          input.consumeId,
          "email_verification",
        ),
        selectUserByConsumedTokenStatement(
          db,
          input.consumeId,
          "email_verification",
        ),
        selectSessionStatement(db, input.session),
      ].filter(Boolean) as D1PreparedStatement[];
      const results = (await db.batch(statements)) as unknown as D1Result[];
      let index = 0;
      const tokenUpdate = results[index++];
      const userUpdate = results[index++];
      const sessionInsert = sessionStatement ? results[index++] : undefined;
      if (eventStatement) index++;
      const tokenSelect = results[index++];
      const userSelect = results[index++];
      const sessionSelect = input.session ? results[index] : undefined;
      if (changes(tokenUpdate) !== 1) return null;
      if (changes(userUpdate) !== 1) {
        throw new AuthRepositoryError(
          "email verification consume did not update user",
          "token_consume_inconsistent",
        );
      }
      if (input.session && changes(sessionInsert) !== 1) {
        throw new AuthRepositoryError(
          "email verification consume did not create session",
          "token_consume_inconsistent",
        );
      }
      return tokenFlowResult(
        (tokenSelect?.results as VerificationTokenRow[])?.[0],
        (userSelect?.results as UserRow[])?.[0],
        (sessionSelect?.results as SessionRow[] | undefined)?.[0],
      );
    },
    async consumePasswordReset(
      input: ConsumePasswordResetInput,
    ): Promise<ConsumeAuthFlowResult | null> {
      assertHmacTokenEnvelope(input.tokenHash);
      const sessionMetadataJson = input.session
        ? assertSessionFromToken(input.session)
        : null;
      const eventStatement = tokenEventStatement(
        db,
        input.event,
        input.consumeId,
        "password_reset",
      );
      const revokeStatement =
        input.revokeExistingSessionsAt !== null &&
        input.revokeExistingSessionsAt !== undefined
          ? db
              .prepare(
                `UPDATE sessions
                 SET revoked_at = ?
                 WHERE revoked_at IS NULL
                   AND user_id = (
                     SELECT user_id FROM verification_tokens
                     WHERE consume_id = ? AND type = 'password_reset'
                   )`,
              )
              .bind(input.revokeExistingSessionsAt, input.consumeId)
          : null;
      const sessionStatement = input.session
        ? db
            .prepare(
              `INSERT INTO sessions (
                id, user_id, token_hash, created_at, expires_at,
                last_seen_at, revoked_at, user_agent_hash, ip_hash, metadata_json
              )
              SELECT ?, user_id, ?, ?, ?, NULL, NULL, ?, ?, ?
              FROM verification_tokens
              WHERE consume_id = ? AND type = 'password_reset' AND user_id IS NOT NULL`,
            )
            .bind(
              input.session.id,
              input.session.tokenHash,
              input.session.createdAt,
              input.session.expiresAt,
              input.session.userAgentHash ?? null,
              input.session.ipHash ?? null,
              sessionMetadataJson,
              input.consumeId,
            )
        : null;
      const statements = [
        db
          .prepare(
            `UPDATE verification_tokens
             SET used_at = ?, consume_id = ?, attempts = attempts + 1
             WHERE token_hash = ?
               AND type = 'password_reset'
               AND used_at IS NULL
               AND consume_id IS NULL
               AND revoked_at IS NULL
               AND expires_at > ?
               AND user_id IS NOT NULL
               AND normalized_email IS NULL
               AND EXISTS (
                 SELECT 1 FROM users
                 WHERE users.id = verification_tokens.user_id
                   AND users.disabled_at IS NULL
               )`,
          )
          .bind(input.consumedAt, input.consumeId, input.tokenHash, input.now),
        db
          .prepare(
            `UPDATE users
             SET password_hash = ?,
                 email_verified_at = CASE
                   WHEN ? IS NOT NULL THEN COALESCE(email_verified_at, ?)
                   ELSE email_verified_at
                 END,
                 updated_at = ?
             WHERE id = (
               SELECT user_id FROM verification_tokens
               WHERE consume_id = ? AND type = 'password_reset'
             )`,
          )
          .bind(
            input.passwordHash,
            input.markEmailVerifiedAt ?? null,
            input.markEmailVerifiedAt ?? null,
            input.updatedAt,
            input.consumeId,
          ),
        revokeStatement,
        sessionStatement,
        eventStatement,
        selectTokenByConsumeStatement(db, input.consumeId, "password_reset"),
        selectUserByConsumedTokenStatement(
          db,
          input.consumeId,
          "password_reset",
        ),
        selectSessionStatement(db, input.session),
      ].filter(Boolean) as D1PreparedStatement[];
      const results = (await db.batch(statements)) as unknown as D1Result[];
      let index = 0;
      const tokenUpdate = results[index++];
      const userUpdate = results[index++];
      const revokeResult = revokeStatement ? results[index++] : undefined;
      const sessionInsert = sessionStatement ? results[index++] : undefined;
      if (eventStatement) index++;
      const tokenSelect = results[index++];
      const userSelect = results[index++];
      const sessionSelect = input.session ? results[index] : undefined;
      if (changes(tokenUpdate) !== 1) return null;
      if (changes(userUpdate) !== 1) {
        throw new AuthRepositoryError(
          "password reset consume did not update user",
          "token_consume_inconsistent",
        );
      }
      if (input.session && changes(sessionInsert) !== 1) {
        throw new AuthRepositoryError(
          "password reset consume did not create session",
          "token_consume_inconsistent",
        );
      }
      return tokenFlowResult(
        (tokenSelect?.results as VerificationTokenRow[])?.[0],
        (userSelect?.results as UserRow[])?.[0],
        (sessionSelect?.results as SessionRow[] | undefined)?.[0],
        { revokedSessions: changes(revokeResult) },
      );
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

export interface AuthEmailRuntime<Env = unknown> {
  env: Env;
  ctx: ExecutionContext;
  mode: AuthRuntimeMode;
  requestId: string;
  publicOrigin: string;
  logger: AuthLogger;
}

export interface AuthLogger {
  log(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface SendAuthEmailInput {
  to: string;
  token: string;
  url: string;
  redirectTo?: string | null;
  expiresAt: number;
}

export interface AuthEmailAdapter<Env = unknown> {
  kind?: string;
  sendMagicLink(
    input: SendAuthEmailInput,
    runtime: AuthEmailRuntime<Env>,
  ): Promise<void>;
  sendEmailVerification(
    input: SendAuthEmailInput,
    runtime: AuthEmailRuntime<Env>,
  ): Promise<void>;
  sendPasswordReset(
    input: SendAuthEmailInput,
    runtime: AuthEmailRuntime<Env>,
  ): Promise<void>;
}

export type AuthRuntimeMode = "development" | "preview" | "production";

export const turnstileEndpointNames = [
  "signup",
  "password_login",
  "magic_link_request",
  "magic_link_consume",
  "email_verification_request",
  "email_verification_consume",
  "password_reset_request",
  "password_reset_confirm",
] as const;

export type TurnstileEndpointName = (typeof turnstileEndpointNames)[number];

export interface AuthConfig extends MinimalAuthConfig {
  runtime: {
    mode: AuthRuntimeMode | "from-env";
    publicOrigin: string | "from-env";
    trustedHosts: string[];
  };
  database: { binding: string };
  session: {
    cookieName: "auto" | string;
    maxAgeDays: number;
    sameSite: "lax" | "strict";
    secure: "auto";
    domain?: string;
    requireVerifiedEmail: boolean;
  };
  request: {
    maxBodyBytes: number;
    requireOriginOnUnsafeMethods: boolean;
  };
  security: {
    allowedRequestOrigins: string[];
    allowedPreviewRequestOrigins: string[];
  };
  passwordHashing: {
    profile: "development-fast" | "workers-balanced" | "high-cost";
    maxConcurrentHashesPerIsolate: number;
  };
  signup: {
    enabled: boolean;
    requireEmailVerificationBeforeSession: boolean;
    enumerationSafe: boolean;
    username: { enabled: boolean; required: boolean };
  };
  login: {
    emailPassword: boolean;
    usernamePassword: boolean;
    magicLink: boolean;
    requireVerifiedEmail: boolean;
  };
  magicLink: {
    allowSignups: boolean;
    expiresInMinutes: number;
    activeTokenPolicy: "invalidate-previous" | "allow-multiple-active";
  };
  passwordReset: {
    enabled: boolean;
    expiresInMinutes: number;
    revokeExistingSessions: boolean;
    createSessionAfterReset: boolean;
    markEmailVerifiedOnReset: boolean;
    activeTokenPolicy: "invalidate-previous" | "allow-multiple-active";
  };
  emailVerification: {
    enabled: boolean;
    expiresInHours: number;
    createSessionAfterVerification: boolean;
    activeTokenPolicy: "invalidate-previous" | "allow-multiple-active";
  };
  turnstile: {
    mode: "disabled" | "optional" | "required";
    endpoints: TurnstileEndpointName[];
    verify?: (input: {
      token: string;
      request: Request;
      runtime: AuthEmailRuntime;
    }) => Promise<boolean>;
  };
  email: AuthEmailAdapter;
  redirects: {
    defaultAfterLogin: string;
    defaultAfterLogout: string;
    defaultAfterEmailVerification: string;
    defaultAfterPasswordReset: string;
    allowedOrigins: string[];
    allowedPreviewOrigins: string[];
  };
}

type RuntimeEnv = Record<string, unknown> & {
  AUTH_SECRET?: string;
  AUTH_SECRET_PREVIOUS?: string;
  AUTH_ENV?: AuthRuntimeMode;
  AUTH_PUBLIC_ORIGIN?: string;
  TURNSTILE_SECRET_KEY?: string;
};

interface RuntimeContext {
  config: AuthConfig;
  env: RuntimeEnv;
  ctx: ExecutionContext;
  mode: AuthRuntimeMode;
  publicOrigin: string;
  requestOrigin: string;
  requestId: string;
  db: D1Database;
  repos: AuthRepositories;
  keyRing: ReturnType<typeof parseAuthKeyRing>;
  cookie: ReturnType<typeof resolveSessionCookie>;
  logger: AuthLogger;
}

const signupSchema = z.object({
  email: z.string(),
  username: z.string().optional(),
  password: z.string(),
});
const loginSchema = z.object({ identifier: z.string(), password: z.string() });
const emailRequestSchema = z.object({
  email: z.string(),
  redirectTo: z.string().optional(),
  afterResetRedirectTo: z.string().optional(),
});
const tokenSchema = z.object({ token: z.string() });
const resetConfirmSchema = z.object({
  token: z.string(),
  password: z.string(),
});

const hashSemaphores = new Map<number, PasswordHashSemaphore>();

export function defineAuthConfig(
  config: MinimalAuthConfig & Partial<AuthConfig>,
): AuthConfig {
  const basePath = config.basePath ?? "/auth";
  if (!/^\/(?!\/)(?!.*\/\/)(?!.*%2f)(?!.*%5c)[^?#]*[^/]$/iu.test(basePath)) {
    throw new AuthCryptoError("invalid auth basePath", "invalid_base_path");
  }
  const turnstile = {
    mode: "disabled",
    endpoints: [],
    ...config.turnstile,
  } satisfies AuthConfig["turnstile"];
  assertTurnstileEndpoints(turnstile.endpoints);
  const passwordHashing = {
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
    ...config.passwordHashing,
  } satisfies AuthConfig["passwordHashing"];
  if (
    !Number.isInteger(passwordHashing.maxConcurrentHashesPerIsolate) ||
    passwordHashing.maxConcurrentHashesPerIsolate < 1
  ) {
    throw new AuthCryptoError(
      "invalid password hash concurrency",
      "invalid_password_hash_concurrency",
    );
  }
  const resolved: AuthConfig = {
    appName: config.appName,
    basePath,
    runtime: {
      mode: "from-env",
      publicOrigin: "from-env",
      trustedHosts: ["localhost:8787", "127.0.0.1:8787"],
      ...config.runtime,
    },
    database: { binding: "AUTH_DB", ...config.database },
    session: {
      cookieName: "auto",
      maxAgeDays: 30,
      sameSite: "lax",
      secure: "auto",
      requireVerifiedEmail: false,
      ...config.session,
    },
    request: {
      maxBodyBytes: 16 * 1024,
      requireOriginOnUnsafeMethods: true,
      ...config.request,
    },
    security: {
      allowedRequestOrigins: [],
      allowedPreviewRequestOrigins: [],
      ...config.security,
    },
    passwordHashing,
    signup: {
      enabled: true,
      requireEmailVerificationBeforeSession: false,
      enumerationSafe: false,
      username: { enabled: true, required: false, ...config.signup?.username },
      ...config.signup,
    },
    login: {
      emailPassword: true,
      usernamePassword: true,
      magicLink: true,
      requireVerifiedEmail: false,
      ...config.login,
    },
    magicLink: {
      allowSignups: false,
      expiresInMinutes: 15,
      activeTokenPolicy: "invalidate-previous",
      ...config.magicLink,
    },
    passwordReset: {
      enabled: true,
      expiresInMinutes: 30,
      revokeExistingSessions: true,
      createSessionAfterReset: false,
      markEmailVerifiedOnReset: true,
      activeTokenPolicy: "invalidate-previous",
      ...config.passwordReset,
    },
    emailVerification: {
      enabled: true,
      expiresInHours: 24,
      createSessionAfterVerification: false,
      activeTokenPolicy: "invalidate-previous",
      ...config.emailVerification,
    },
    turnstile,
    email: config.email ?? terminalEmail({ outbox: true }),
    redirects: {
      defaultAfterLogin: "/",
      defaultAfterLogout: "/",
      defaultAfterEmailVerification: "/",
      defaultAfterPasswordReset: "/",
      allowedOrigins: [],
      allowedPreviewOrigins: [],
      ...config.redirects,
    },
  };
  assertRuntimeOptions(resolved);
  assertAuthConfigOrigins(resolved);
  assertSessionOptions(resolved);
  assertRequestOptions(resolved);
  assertFeatureOptions(resolved);
  return resolved;
}

function assertRuntimeOptions(config: AuthConfig): void {
  const mode = config.runtime.mode;
  if (
    config.runtime.publicOrigin !== "from-env" &&
    !(mode === "from-env"
      ? isExactAllowedOrigin(config.runtime.publicOrigin)
      : isExactPublicOriginForMode(config.runtime.publicOrigin, mode))
  ) {
    throw new AuthCryptoError(
      "runtime publicOrigin must be an exact origin",
      "invalid_public_origin",
    );
  }
}

function assertAuthConfigOrigins(config: AuthConfig): void {
  assertExactOriginList(
    config.security.allowedRequestOrigins,
    "invalid_request_origin",
  );
  assertExactOriginList(
    config.security.allowedPreviewRequestOrigins,
    "invalid_request_origin",
  );
  assertExactOriginList(
    config.redirects.allowedOrigins,
    "invalid_redirect_origin",
  );
  assertExactOriginList(
    config.redirects.allowedPreviewOrigins,
    "invalid_redirect_origin",
  );
}

function assertSessionOptions(config: AuthConfig): void {
  if (
    config.session.sameSite !== "lax" &&
    config.session.sameSite !== "strict"
  ) {
    throw new AuthCryptoError(
      "unsupported SameSite mode",
      "invalid_cookie_config",
    );
  }
  if (config.session.cookieName !== "auto") {
    assertValidSessionCookieName(config.session.cookieName);
  }
  if (config.session.domain) {
    assertValidSessionCookieDomain(config.session.domain);
  }
  if (
    config.session.cookieName.startsWith("__Host-") &&
    config.session.domain
  ) {
    throw new AuthCryptoError(
      "__Host- cookies require Secure and no Domain",
      "invalid_cookie_config",
    );
  }
}

function assertRequestOptions(config: AuthConfig): void {
  if (
    !Number.isInteger(config.request.maxBodyBytes) ||
    config.request.maxBodyBytes < 1
  ) {
    throw new AuthCryptoError(
      "invalid request maxBodyBytes",
      "invalid_request_config",
    );
  }
}

function assertFeatureOptions(config: AuthConfig): void {
  for (const policy of [
    config.magicLink.activeTokenPolicy,
    config.passwordReset.activeTokenPolicy,
    config.emailVerification.activeTokenPolicy,
  ]) {
    if (
      policy !== "invalidate-previous" &&
      policy !== "allow-multiple-active"
    ) {
      throw new AuthCryptoError(
        "invalid active token policy",
        "invalid_active_token_policy",
      );
    }
  }
  if (config.magicLink.allowSignups) {
    if (!config.signup.enabled) {
      throw new AuthCryptoError(
        "magic-link signups require signup.enabled",
        "invalid_feature_config",
      );
    }
    if (config.signup.username.required) {
      throw new AuthCryptoError(
        "magic-link signups cannot require usernames",
        "invalid_feature_config",
      );
    }
  }
  if (config.signup.enumerationSafe) {
    if (!config.emailVerification.enabled) {
      throw new AuthCryptoError(
        "enumeration-safe signup requires email verification",
        "invalid_feature_config",
      );
    }
    if (!config.signup.requireEmailVerificationBeforeSession) {
      throw new AuthCryptoError(
        "enumeration-safe signup must require verification before session",
        "invalid_feature_config",
      );
    }
    if (config.signup.username.required) {
      throw new AuthCryptoError(
        "enumeration-safe signup cannot require usernames",
        "invalid_feature_config",
      );
    }
  }
  if (
    !config.emailVerification.enabled &&
    (config.signup.requireEmailVerificationBeforeSession ||
      config.login.requireVerifiedEmail ||
      config.session.requireVerifiedEmail)
  ) {
    throw new AuthCryptoError(
      "verified-email requirements need email verification",
      "invalid_feature_config",
    );
  }
}

function assertExactOriginList(values: string[], code: string): void {
  if (!Array.isArray(values)) {
    throw new AuthCryptoError("origin allowlist must be an array", code);
  }
  for (const value of values) {
    if (typeof value !== "string" || !isExactAllowedOrigin(value)) {
      throw new AuthCryptoError("origin allowlist entry is invalid", code);
    }
  }
}

function isExactAllowedOrigin(value: string): boolean {
  if (value.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (value !== url.origin) return false;
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  );
}

export function terminalEmail(
  options: { outbox?: boolean; print?: (line: string) => void } = {},
): AuthEmailAdapter & { outbox: SendAuthEmailInput[] } {
  const outbox: SendAuthEmailInput[] = [];
  async function send(input: SendAuthEmailInput, runtime: AuthEmailRuntime) {
    if (runtime.mode !== "development") {
      throw new AuthCryptoError(
        "terminal email is development-only",
        "terminal_email_unavailable",
      );
    }
    if (options.outbox) outbox.push(input);
    (options.print ?? console.log)(`[cf-auth dev email] ${input.url}`);
    runtime.logger.log("[cf-auth dev email sent]", {
      recipient: "present",
      expiresAt: input.expiresAt,
    });
  }
  return {
    kind: "terminal",
    outbox,
    sendMagicLink: send,
    sendEmailVerification: send,
    sendPasswordReset: send,
  };
}

export function byEnvironment<Env = unknown>(adapters: {
  development: AuthEmailAdapter<Env>;
  preview: AuthEmailAdapter<Env>;
  production: AuthEmailAdapter<Env>;
}): AuthEmailAdapter<Env> {
  for (const mode of ["development", "preview", "production"] as const) {
    const adapter = adapters[mode];
    if (
      !adapter?.sendMagicLink ||
      !adapter.sendEmailVerification ||
      !adapter.sendPasswordReset
    ) {
      throw new AuthCryptoError(
        `missing ${mode} email adapter`,
        "invalid_email_adapter",
      );
    }
  }
  function select(runtime: AuthEmailRuntime<Env>) {
    return adapters[runtime.mode];
  }
  return {
    kind: "by-environment",
    sendMagicLink(input, runtime) {
      return select(runtime).sendMagicLink(input, runtime);
    },
    sendEmailVerification(input, runtime) {
      return select(runtime).sendEmailVerification(input, runtime);
    },
    sendPasswordReset(input, runtime) {
      return select(runtime).sendPasswordReset(input, runtime);
    },
  };
}

function assertTurnstileEndpoints(endpoints: readonly string[]): void {
  for (const endpoint of endpoints) {
    if (!turnstileEndpointNames.includes(endpoint as TurnstileEndpointName)) {
      throw new AuthCryptoError(
        `unknown Turnstile endpoint: ${endpoint}`,
        "invalid_turnstile_endpoint",
      );
    }
  }
}

export function createAuthHandler(
  configInput: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
) {
  const config =
    "runtime" in configInput
      ? (configInput as AuthConfig)
      : defineAuthConfig(configInput);
  return {
    async fetch(
      request: Request,
      envInput?: unknown,
      ctxInput?: ExecutionContext,
    ): Promise<Response | null> {
      const url = new URL(request.url);
      const path = stripBasePath(url.pathname, config.basePath);
      if (path === null) return null;
      const ctx =
        ctxInput ?? ({ waitUntil() {} } as unknown as ExecutionContext);
      let runtime: RuntimeContext;
      try {
        runtime = resolveRuntime(config, request, envInput, ctx);
      } catch (error) {
        if (
          error instanceof AuthCryptoError &&
          error.code === "untrusted_host"
        ) {
          return errorResponse(error, 403, "untrusted_host");
        }
        return errorResponse(error, 500, "config_error");
      }
      if (request.method === "OPTIONS")
        return handlePreflight(request, runtime);
      if (!checkOrigin(request, runtime))
        return errorResponse("Invalid origin", 403, "invalid_origin");

      try {
        if (path === "/dev/emails" && request.method === "GET")
          return handleDevEmails(runtime);
        if (path === "/signup" && request.method === "POST")
          return await handleSignup(request, runtime);
        if (path === "/login" && request.method === "POST")
          return await handleLogin(request, runtime);
        if (path === "/logout" && request.method === "POST")
          return await handleLogout(request, runtime);
        if (path === "/user" && request.method === "GET")
          return await handleUser(request, runtime);
        if (path === "/magic-link/request" && request.method === "POST")
          return await handleMagicLinkRequest(request, runtime);
        if (path === "/magic-link/verify" && request.method === "GET")
          return tokenPage(
            request,
            runtime,
            "magic",
            "/magic-link/consume",
            "Continue",
          );
        if (path === "/magic-link/consume" && request.method === "POST")
          return await handleMagicLinkConsume(request, runtime);
        if (path === "/email/verify/request" && request.method === "POST")
          return await handleEmailVerifyRequest(request, runtime);
        if (path === "/email/verify" && request.method === "GET")
          return tokenPage(
            request,
            runtime,
            "verify",
            "/email/verify/consume",
            "Verify email",
          );
        if (path === "/email/verify/consume" && request.method === "POST")
          return await handleEmailVerifyConsume(request, runtime);
        if (path === "/password/reset/request" && request.method === "POST")
          return await handlePasswordResetRequest(request, runtime);
        if (path === "/password/reset" && request.method === "GET")
          return resetPage(request, runtime);
        if (path === "/password/reset/confirm" && request.method === "POST")
          return await handlePasswordResetConfirm(request, runtime);
        return errorResponse("Not found", 404, "not_found");
      } catch (error) {
        if (
          error instanceof AuthCryptoError ||
          error instanceof AuthRepositoryError ||
          error instanceof z.ZodError
        ) {
          return errorResponse(
            error,
            400,
            error instanceof z.ZodError ? "validation_failed" : error.code,
          );
        }
        return errorResponse(error, 500, "server_error");
      }
    },
  };
}

export async function getAuthSessionFromRequest(
  configInput: AuthConfig | (MinimalAuthConfig & Partial<AuthConfig>),
  request: Request,
  envInput?: unknown,
  ctxInput?: ExecutionContext,
): Promise<SessionWithUserRow | null> {
  const config =
    "runtime" in configInput
      ? (configInput as AuthConfig)
      : defineAuthConfig(configInput);
  const ctx = ctxInput ?? ({ waitUntil() {} } as unknown as ExecutionContext);
  const runtime = resolveRuntime(config, request, envInput, ctx);
  return getSession(request, runtime);
}

async function handleSignup(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.signup.enabled)
    return errorResponse("Not found", 404, "not_found");
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "signup", rawBody, request);
  const body = signupSchema.parse(rawBody);
  const normalizedEmail = normalizeEmail(body.email);
  const username = body.username ? body.username.trim() : null;
  const normalizedUsername = username ? normalizeUsername(username) : null;
  if (runtime.config.signup.username.required && !normalizedUsername)
    return errorResponse("Username required", 400, "validation_failed");
  await rateLimit(
    runtime,
    "signup",
    "email",
    normalizedEmail,
    3,
    60 * 60 * 1000,
    request,
  );
  const passwordHash = await passwordSemaphore(runtime).run(() =>
    hashPassword(body.password, {
      profile: runtime.config.passwordHashing.profile,
    }),
  );
  const now = Date.now();
  let user: UserRow;
  try {
    user = await runtime.repos.users.createUser({
      id: randomId("usr_"),
      email: body.email.trim(),
      normalizedEmail,
      username,
      normalizedUsername,
      passwordHash,
      createdAt: now,
    });
  } catch (error) {
    queueAuthEvent(runtime, request, "signup_failed", {
      metadata: { reason: "create_user_failed" },
    });
    if (runtime.config.signup.enumerationSafe) return json({ ok: true });
    throw error;
  }
  queueAuthEvent(runtime, request, "signup_success", {
    userId: user.id,
    metadata: {
      sessionCreated:
        !runtime.config.signup.requireEmailVerificationBeforeSession &&
        !runtime.config.signup.enumerationSafe,
    },
  });
  if (runtime.config.emailVerification.enabled)
    await sendVerificationEmail(user, runtime, null);
  if (
    runtime.config.signup.requireEmailVerificationBeforeSession ||
    runtime.config.signup.enumerationSafe
  ) {
    return runtime.config.signup.enumerationSafe
      ? json({ ok: true })
      : json({ user: publicUser(user) });
  }
  return jsonWithSession(
    { user: publicUser(user) },
    runtime,
    user,
    request,
    now,
  );
}

async function handleLogin(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (
    !runtime.config.login.emailPassword &&
    !runtime.config.login.usernamePassword
  )
    return errorResponse("Not found", 404, "not_found");
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "password_login", rawBody, request);
  const body = loginSchema.parse(rawBody);
  const isEmail = body.identifier.includes("@");
  let user: UserRow | null = null;
  try {
    if (isEmail && runtime.config.login.emailPassword) {
      const normalized = normalizeEmail(body.identifier);
      await rateLimit(
        runtime,
        "password_login",
        "email",
        normalized,
        5,
        10 * 60 * 1000,
        request,
      );
      user = await runtime.repos.users.findUserByNormalizedEmail(normalized);
    } else if (!isEmail && runtime.config.login.usernamePassword) {
      const normalized = normalizeUsername(body.identifier);
      await rateLimit(
        runtime,
        "password_login",
        "identifier",
        normalized,
        5,
        10 * 60 * 1000,
        request,
      );
      user = await runtime.repos.users.findUserByNormalizedUsername(normalized);
    }
  } catch {
    await passwordSemaphore(runtime).run(() =>
      dummyVerifyPassword(body.password, {
        profile: runtime.config.passwordHashing.profile,
      }),
    );
    queueAuthEvent(runtime, request, "dummy_password_verification", {
      metadata: { subjectType: isEmail ? "email" : "identifier" },
    });
    queueAuthEvent(runtime, request, "password_login_failed", {
      metadata: { reason: "invalid_identifier" },
    });
    return errorResponse("Invalid credentials", 401, "invalid_credentials");
  }
  if (!user?.password_hash) {
    await passwordSemaphore(runtime).run(() =>
      dummyVerifyPassword(body.password, {
        profile: runtime.config.passwordHashing.profile,
      }),
    );
    queueAuthEvent(runtime, request, "dummy_password_verification", {
      metadata: {
        subjectType: isEmail ? "email" : "identifier",
        userPresent: Boolean(user),
      },
    });
    queueAuthEvent(runtime, request, "password_login_failed", {
      userId: user?.id ?? null,
      metadata: { reason: user ? "password_not_set" : "user_not_found" },
    });
    return errorResponse("Invalid credentials", 401, "invalid_credentials");
  }
  const ok = await passwordSemaphore(runtime).run(() =>
    verifyPassword(body.password, user.password_hash ?? ""),
  );
  if (!ok) {
    queueAuthEvent(runtime, request, "password_login_failed", {
      userId: user.id,
      metadata: { reason: "invalid_password" },
    });
    return errorResponse("Invalid credentials", 401, "invalid_credentials");
  }
  if (user.disabled_at !== null) {
    queueAuthEvent(runtime, request, "disabled_user_auth_attempt", {
      userId: user.id,
      metadata: { flow: "password_login" },
    });
    return errorResponse("Account disabled", 403, "account_disabled");
  }
  if (
    runtime.config.login.requireVerifiedEmail &&
    user.email_verified_at === null
  ) {
    queueAuthEvent(runtime, request, "password_login_failed", {
      userId: user.id,
      metadata: { reason: "email_unverified" },
    });
    return errorResponse(
      "Email verification required",
      403,
      "email_verification_required",
    );
  }
  queueAuthEvent(runtime, request, "password_login_success", {
    userId: user.id,
  });
  return jsonWithSession(
    { user: publicUser(user) },
    runtime,
    user,
    request,
    Date.now(),
  );
}

async function handleLogout(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  const session = await getSession(request, runtime);
  if (session) {
    await runtime.repos.sessions.revokeSession(session.id, Date.now());
    queueAuthEvent(runtime, request, "session_revoked", {
      userId: session.user_id,
      metadata: { reason: "logout" },
    });
  }
  return json({ ok: true }, 200, {
    "Set-Cookie": serializeClearSessionCookie(runtime.cookie),
  });
}

async function handleUser(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  const session = await getSession(request, runtime);
  if (!session) return json({ user: null });
  if (
    runtime.config.session.requireVerifiedEmail &&
    session.user.email_verified_at === null
  )
    return json({ user: null });
  return json({ user: publicUser(session.user) });
}

async function handleMagicLinkRequest(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.login.magicLink)
    return errorResponse("Not found", 404, "not_found");
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "magic_link_request", rawBody, request);
  const body = emailRequestSchema.parse(rawBody);
  const normalizedEmail = normalizeEmail(body.email);
  await rateLimit(
    runtime,
    "magic_link_request",
    "email",
    normalizedEmail,
    3,
    15 * 60 * 1000,
    request,
  );
  const redirectTo = safeRedirect(
    body.redirectTo,
    runtime,
    runtime.config.redirects.defaultAfterLogin,
  );
  const user =
    await runtime.repos.users.findUserByNormalizedEmail(normalizedEmail);
  if (user && user.disabled_at === null) {
    queueAuthEvent(runtime, request, "magic_link_request", {
      userId: user.id,
      metadata: { subject: "existing_user" },
    });
    scheduleAuthTask(
      runtime,
      createAndSendToken(
        runtime,
        "magic",
        "magic_link",
        user.email,
        user.id,
        null,
        redirectTo,
        runtime.config.magicLink.expiresInMinutes * 60 * 1000,
      ),
    );
  } else if (runtime.config.magicLink.allowSignups) {
    queueAuthEvent(runtime, request, "magic_link_request", {
      metadata: { subject: "jit_signup" },
    });
    scheduleAuthTask(
      runtime,
      createAndSendToken(
        runtime,
        "magic",
        "magic_link",
        normalizedEmail,
        null,
        normalizedEmail,
        redirectTo,
        runtime.config.magicLink.expiresInMinutes * 60 * 1000,
      ),
    );
  } else {
    queueAuthEvent(runtime, request, "magic_link_request", {
      metadata: { subject: "generic" },
    });
    performDummyTokenWork(runtime, "magic", "magic_link");
  }
  return json({ ok: true });
}

async function handleMagicLinkConsume(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  const mode = contentMode(request);
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "magic_link_consume", rawBody, request);
  const body = tokenSchema.parse(rawBody);
  await rateLimit(
    runtime,
    "magic_link_consume",
    "ip",
    clientIp(request),
    30,
    15 * 60 * 1000,
    request,
  );
  let tokenHash: string;
  try {
    tokenHash = hashRawAuthToken(body.token, runtime.keyRing, "magic_link");
  } catch (error) {
    queueAuthEvent(runtime, request, "magic_link_consume_failed", {
      metadata: {
        reason:
          error instanceof AuthCryptoError ? error.code : "token_hash_failed",
      },
    });
    throw error;
  }
  const active = runtime.config.magicLink.allowSignups
    ? await runtime.repos.verificationTokens.findActiveVerificationTokenByHash(
        tokenHash,
        "magic_link",
        Date.now(),
      )
    : null;
  const now = Date.now();
  const prepared = prepareSessionForRequest(runtime, request, now);
  const jitUser =
    active?.normalized_email && !active.user_id
      ? { id: randomId("usr_"), createdAt: now }
      : undefined;
  const consumed =
    await runtime.repos.verificationTokens.consumeMagicLinkAndCreateSession({
      tokenHash,
      consumeId: randomId("con_"),
      consumedAt: now,
      now,
      session: prepared.session,
      ...(jitUser ? { jitUser } : {}),
      event: tokenConsumeEventInput(
        runtime,
        request,
        "magic_link_consume_success",
        { jitSignup: Boolean(jitUser) },
      ),
    });
  if (!consumed) {
    queueAuthEvent(runtime, request, "magic_link_consume_failed", {
      metadata: { reason: "invalid_or_replayed" },
    });
    return errorResponse("Invalid token", 400, "invalid_token");
  }
  return sessionConsumeResponseWithToken(
    {
      user: publicUser(consumed.user),
      redirectTo:
        consumed.redirectTo ?? runtime.config.redirects.defaultAfterLogin,
    },
    runtime,
    prepared.rawToken,
    mode,
  );
}

async function handleEmailVerifyRequest(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.emailVerification.enabled)
    return errorResponse("Not found", 404, "not_found");
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(
    runtime,
    "email_verification_request",
    rawBody,
    request,
  );
  const body = emailRequestSchema.parse(rawBody);
  const normalizedEmail = normalizeEmail(body.email);
  await rateLimit(
    runtime,
    "email_verification_request",
    "email",
    normalizedEmail,
    3,
    60 * 60 * 1000,
    request,
  );
  const redirectTo = safeRedirect(
    body.redirectTo,
    runtime,
    runtime.config.redirects.defaultAfterEmailVerification,
  );
  const user =
    await runtime.repos.users.findUserByNormalizedEmail(normalizedEmail);
  if (user && user.disabled_at === null && user.email_verified_at === null) {
    queueAuthEvent(runtime, request, "email_verification_request", {
      userId: user.id,
      metadata: { subject: "existing_user" },
    });
    scheduleAuthTask(runtime, sendVerificationEmail(user, runtime, redirectTo));
  } else {
    queueAuthEvent(runtime, request, "email_verification_request", {
      userId: user?.id ?? null,
      metadata: {
        subject:
          user && user.disabled_at !== null
            ? "disabled_user"
            : user && user.email_verified_at !== null
              ? "already_verified"
              : "generic",
      },
    });
    performDummyTokenWork(runtime, "verify", "email_verification");
  }
  return json({ ok: true });
}

async function handleEmailVerifyConsume(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.emailVerification.enabled)
    return errorResponse("Not found", 404, "not_found");
  const mode = contentMode(request);
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(
    runtime,
    "email_verification_consume",
    rawBody,
    request,
  );
  const body = tokenSchema.parse(rawBody);
  await rateLimit(
    runtime,
    "email_verification_consume",
    "ip",
    clientIp(request),
    30,
    60 * 60 * 1000,
    request,
  );
  let tokenHash: string;
  try {
    tokenHash = hashRawAuthToken(
      body.token,
      runtime.keyRing,
      "email_verification",
    );
  } catch (error) {
    queueAuthEvent(runtime, request, "email_verification_consume_failed", {
      metadata: {
        reason:
          error instanceof AuthCryptoError ? error.code : "token_hash_failed",
      },
    });
    throw error;
  }
  const now = Date.now();
  const prepared = runtime.config.emailVerification
    .createSessionAfterVerification
    ? prepareSessionForRequest(runtime, request, now)
    : null;
  const consumed =
    await runtime.repos.verificationTokens.consumeEmailVerification({
      tokenHash,
      consumeId: randomId("con_"),
      consumedAt: now,
      now,
      verifiedAt: now,
      updatedAt: now,
      ...(prepared ? { session: prepared.session } : {}),
      event: tokenConsumeEventInput(
        runtime,
        request,
        "email_verification_consume_success",
        {
          sessionCreated:
            runtime.config.emailVerification.createSessionAfterVerification,
        },
      ),
    });
  if (!consumed) {
    queueAuthEvent(runtime, request, "email_verification_consume_failed", {
      metadata: { reason: "invalid_or_replayed" },
    });
    return errorResponse("Invalid token", 400, "invalid_token");
  }
  const payload = {
    user: publicUser(consumed.user),
    redirectTo:
      consumed.redirectTo ??
      runtime.config.redirects.defaultAfterEmailVerification,
  };
  return prepared
    ? sessionConsumeResponseWithToken(payload, runtime, prepared.rawToken, mode)
    : consumeResponse(payload, mode);
}

async function handlePasswordResetRequest(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.passwordReset.enabled)
    return errorResponse("Not found", 404, "not_found");
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "password_reset_request", rawBody, request);
  const body = emailRequestSchema.parse(rawBody);
  const normalizedEmail = normalizeEmail(body.email);
  await rateLimit(
    runtime,
    "password_reset_request",
    "email",
    normalizedEmail,
    3,
    60 * 60 * 1000,
    request,
  );
  const redirectTo = safeRedirect(
    body.afterResetRedirectTo,
    runtime,
    runtime.config.redirects.defaultAfterPasswordReset,
  );
  const user =
    await runtime.repos.users.findUserByNormalizedEmail(normalizedEmail);
  if (user && user.disabled_at === null) {
    queueAuthEvent(runtime, request, "password_reset_request", {
      userId: user.id,
      metadata: { subject: "existing_user" },
    });
    scheduleAuthTask(
      runtime,
      createAndSendToken(
        runtime,
        "reset",
        "password_reset",
        user.email,
        user.id,
        null,
        redirectTo,
        runtime.config.passwordReset.expiresInMinutes * 60 * 1000,
      ),
    );
  } else {
    queueAuthEvent(runtime, request, "password_reset_request", {
      userId: user?.id ?? null,
      metadata: {
        subject: user ? "disabled_user" : "generic",
      },
    });
    performDummyTokenWork(runtime, "reset", "password_reset");
  }
  return json({ ok: true });
}

async function handlePasswordResetConfirm(
  request: Request,
  runtime: RuntimeContext,
): Promise<Response> {
  if (!runtime.config.passwordReset.enabled)
    return errorResponse("Not found", 404, "not_found");
  const mode = contentMode(request);
  const rawBody = await parseBody(request, runtime);
  await enforceTurnstile(runtime, "password_reset_confirm", rawBody, request);
  const body = resetConfirmSchema.parse(rawBody);
  await rateLimit(
    runtime,
    "password_reset_confirm",
    "ip",
    clientIp(request),
    10,
    60 * 60 * 1000,
    request,
  );
  const validation = validatePassword(body.password);
  if (!validation.ok)
    return errorResponse(
      validation.message ?? "Invalid password",
      400,
      validation.code ?? "invalid_password",
    );
  let tokenHash: string;
  try {
    tokenHash = hashRawAuthToken(body.token, runtime.keyRing, "password_reset");
  } catch (error) {
    queueAuthEvent(runtime, request, "password_reset_confirm_failed", {
      metadata: {
        reason:
          error instanceof AuthCryptoError ? error.code : "token_hash_failed",
      },
    });
    throw error;
  }
  const active =
    await runtime.repos.verificationTokens.findActiveVerificationTokenByHash(
      tokenHash,
      "password_reset",
      Date.now(),
    );
  if (!active?.user_id) {
    queueAuthEvent(runtime, request, "password_reset_confirm_failed", {
      metadata: { reason: "invalid_or_expired" },
    });
    return errorResponse("Invalid token", 400, "invalid_token");
  }
  const activeUser = await runtime.repos.users.findUserById(active.user_id);
  if (!activeUser || activeUser.disabled_at !== null) {
    queueAuthEvent(runtime, request, "password_reset_confirm_failed", {
      userId: activeUser?.id ?? null,
      metadata: {
        reason: activeUser ? "disabled_user" : "user_missing",
      },
    });
    return errorResponse("Invalid token", 400, "invalid_token");
  }
  const passwordHash = await passwordSemaphore(runtime).run(() =>
    hashPassword(body.password, {
      profile: runtime.config.passwordHashing.profile,
    }),
  );
  const now = Date.now();
  const prepared = runtime.config.passwordReset.createSessionAfterReset
    ? prepareSessionForRequest(runtime, request, now)
    : null;
  const consumed = await runtime.repos.verificationTokens.consumePasswordReset({
    tokenHash,
    consumeId: randomId("con_"),
    consumedAt: now,
    now,
    passwordHash,
    updatedAt: now,
    markEmailVerifiedAt: runtime.config.passwordReset.markEmailVerifiedOnReset
      ? now
      : null,
    revokeExistingSessionsAt: runtime.config.passwordReset
      .revokeExistingSessions
      ? now
      : null,
    ...(prepared ? { session: prepared.session } : {}),
    event: tokenConsumeEventInput(
      runtime,
      request,
      "password_reset_confirm_success",
      {
        sessionCreated: runtime.config.passwordReset.createSessionAfterReset,
      },
    ),
  });
  if (!consumed) {
    queueAuthEvent(runtime, request, "password_reset_confirm_failed", {
      metadata: { reason: "invalid_or_replayed" },
    });
    return errorResponse("Invalid token", 400, "invalid_token");
  }
  if (runtime.config.passwordReset.revokeExistingSessions) {
    queueAuthEvent(runtime, request, "session_revoked", {
      userId: consumed.user.id,
      metadata: {
        reason: "password_reset",
        count: consumed.revokedSessions ?? 0,
      },
    });
  }
  const payload = {
    user: publicUser(consumed.user),
    redirectTo:
      consumed.redirectTo ?? runtime.config.redirects.defaultAfterPasswordReset,
  };
  return prepared
    ? sessionConsumeResponseWithToken(payload, runtime, prepared.rawToken, mode)
    : consumeResponse(payload, mode);
}

async function sendVerificationEmail(
  user: UserRow,
  runtime: RuntimeContext,
  redirectToInput: string | null,
): Promise<void> {
  const redirectTo = safeRedirect(
    redirectToInput,
    runtime,
    runtime.config.redirects.defaultAfterEmailVerification,
  );
  await createAndSendToken(
    runtime,
    "verify",
    "email_verification",
    user.email,
    user.id,
    null,
    redirectTo,
    runtime.config.emailVerification.expiresInHours * 60 * 60 * 1000,
  );
}

async function createAndSendToken(
  runtime: RuntimeContext,
  rawPurpose: "magic" | "verify" | "reset",
  type: "magic_link" | "email_verification" | "password_reset",
  to: string,
  userId: string | null,
  normalizedEmail: string | null,
  redirectTo: string,
  ttlMs: number,
): Promise<void> {
  const now = Date.now();
  if (
    (userId || normalizedEmail) &&
    activeTokenPolicy(runtime, type) === "invalidate-previous"
  ) {
    await runtime.repos.verificationTokens.revokeActiveVerificationTokens({
      type,
      userId,
      normalizedEmail,
      revokedAt: now,
      revokedReason: "superseded",
    });
  }
  const token = generateRawAuthToken(rawPurpose, runtime.keyRing.current);
  const tokenHash = hashRawAuthToken(token, runtime.keyRing, type);
  await runtime.repos.verificationTokens.createVerificationToken({
    id: randomId("vtok_"),
    userId,
    normalizedEmail,
    tokenHash,
    type,
    redirectTo,
    createdAt: now,
    expiresAt: now + ttlMs,
  });
  const path =
    rawPurpose === "magic"
      ? "/magic-link/verify"
      : rawPurpose === "verify"
        ? "/email/verify"
        : "/password/reset";
  const url = `${runtime.publicOrigin}${runtime.config.basePath}${path}?token=${encodeURIComponent(token)}`;
  const input = { to, token, url, redirectTo, expiresAt: now + ttlMs };
  try {
    if (rawPurpose === "magic")
      await runtime.config.email.sendMagicLink(input, emailRuntime(runtime));
    else if (rawPurpose === "verify")
      await runtime.config.email.sendEmailVerification(
        input,
        emailRuntime(runtime),
      );
    else
      await runtime.config.email.sendPasswordReset(
        input,
        emailRuntime(runtime),
      );
  } catch (error) {
    await recordEmailSendFailure(runtime, {
      type,
      userId,
      normalizedEmail,
      error,
    });
  }
}

async function recordEmailSendFailure(
  runtime: RuntimeContext,
  input: {
    type: "magic_link" | "email_verification" | "password_reset";
    userId: string | null;
    normalizedEmail: string | null;
    error: unknown;
  },
): Promise<void> {
  const metadata = {
    tokenType: input.type,
    subjectType: input.userId
      ? "user"
      : input.normalizedEmail
        ? "normalized_email"
        : "unknown",
    adapter: runtime.config.email.kind ?? "unknown",
    errorCode:
      input.error instanceof AuthCryptoError
        ? input.error.code
        : "email_send_failed",
    errorName: input.error instanceof Error ? input.error.name : "UnknownError",
  };
  runtime.logger.error("email_send_failed", metadata);
  try {
    await runtime.repos.events.writeAuthEvent({
      id: randomId("evt_"),
      userId: input.userId,
      eventType: "email_send_failed",
      createdAt: Date.now(),
      requestId: runtime.requestId,
      metadataJson: JSON.stringify(metadata),
    });
  } catch (eventError) {
    runtime.logger.error("email_send_failed_event_write_failed", {
      errorName: eventError instanceof Error ? eventError.name : "UnknownError",
    });
  }
}

function queueAuthEvent(
  runtime: RuntimeContext,
  request: Request,
  eventType: string,
  options: {
    userId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
  } = {},
): void {
  scheduleAuthTask(
    runtime,
    recordAuthEvent(runtime, request, eventType, options),
  );
}

async function recordAuthEvent(
  runtime: RuntimeContext,
  request: Request,
  eventType: string,
  options: {
    userId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  try {
    await runtime.repos.events.writeAuthEvent({
      id: randomId("evt_"),
      userId: options.userId ?? null,
      eventType,
      createdAt: Date.now(),
      ipHash: deriveEventHash({
        keyRing: runtime.keyRing,
        purpose: "event-ip-hash",
        value: canonicalizeIp(clientIp(request)),
      }),
      userAgentHash: deriveEventHash({
        keyRing: runtime.keyRing,
        purpose: "event-user-agent-hash",
        value: canonicalizeUserAgent(request.headers.get("User-Agent")),
      }),
      requestId: runtime.requestId,
      metadataJson: JSON.stringify(options.metadata ?? {}),
    });
  } catch (error) {
    runtime.logger.error("auth_event_write_failed", {
      eventType,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function scheduleAuthTask(runtime: RuntimeContext, task: Promise<void>): void {
  runtime.ctx.waitUntil(
    task.catch((error) => {
      runtime.logger.error("deferred_auth_task_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode:
          error instanceof AuthCryptoError
            ? error.code
            : error instanceof AuthRepositoryError
              ? error.code
              : "unknown",
      });
    }),
  );
}

function performDummyTokenWork(
  runtime: RuntimeContext,
  rawPurpose: "magic" | "verify" | "reset",
  type: "magic_link" | "email_verification" | "password_reset",
): void {
  const token = generateRawAuthToken(rawPurpose, runtime.keyRing.current);
  hashRawAuthToken(token, runtime.keyRing, type);
}

function tokenPage(
  request: Request,
  runtime: RuntimeContext,
  purpose: "magic" | "verify",
  action: string,
  label: string,
): Response {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const parsed = parseRawAuthToken(token);
  if (parsed.purpose !== purpose)
    throw new AuthCryptoError("wrong token purpose", "wrong_token_purpose");
  return html(
    `<form method="post" action="${runtime.config.basePath}${action}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">${escapeHtml(label)}</button></form>`,
  );
}

function resetPage(request: Request, runtime: RuntimeContext): Response {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const parsed = parseRawAuthToken(token);
  if (parsed.purpose !== "reset")
    throw new AuthCryptoError("wrong token purpose", "wrong_token_purpose");
  return html(
    `<form method="post" action="${runtime.config.basePath}/password/reset/confirm"><input type="hidden" name="token" value="${escapeHtml(token)}"><input name="password" type="password" autocomplete="new-password"><button type="submit">Reset password</button></form>`,
  );
}

function handleDevEmails(runtime: RuntimeContext): Response {
  if (runtime.mode !== "development" || !("outbox" in runtime.config.email))
    return errorResponse("Not found", 404, "not_found");
  return json({ emails: runtime.config.email.outbox });
}

function prepareSessionForRequest(
  runtime: RuntimeContext,
  request: Request,
  now: number,
): { rawToken: string; session: CreateSessionFromTokenInput } {
  const rawToken = generateRawAuthToken("ses", runtime.keyRing.current);
  return {
    rawToken,
    session: {
      id: randomId("ses_"),
      tokenHash: hashRawAuthToken(rawToken, runtime.keyRing, "session"),
      createdAt: now,
      expiresAt: now + runtime.config.session.maxAgeDays * 24 * 60 * 60 * 1000,
      ipHash: deriveEventHash({
        keyRing: runtime.keyRing,
        purpose: "event-ip-hash",
        value: canonicalizeIp(clientIp(request)),
      }),
      userAgentHash: deriveEventHash({
        keyRing: runtime.keyRing,
        purpose: "event-user-agent-hash",
        value: canonicalizeUserAgent(request.headers.get("User-Agent")),
      }),
    },
  };
}

function tokenConsumeEventInput(
  runtime: RuntimeContext,
  request: Request,
  eventType: string,
  metadata: Record<string, string | number | boolean | null> = {},
): TokenConsumeEventInput {
  return {
    id: randomId("evt_"),
    eventType,
    createdAt: Date.now(),
    ipHash: deriveEventHash({
      keyRing: runtime.keyRing,
      purpose: "event-ip-hash",
      value: canonicalizeIp(clientIp(request)),
    }),
    userAgentHash: deriveEventHash({
      keyRing: runtime.keyRing,
      purpose: "event-user-agent-hash",
      value: canonicalizeUserAgent(request.headers.get("User-Agent")),
    }),
    requestId: runtime.requestId,
    metadataJson: JSON.stringify(metadata),
  };
}

async function jsonWithSession(
  payload: unknown,
  runtime: RuntimeContext,
  user: UserRow,
  request: Request,
  now: number,
): Promise<Response> {
  const prepared = prepareSessionForRequest(runtime, request, now);
  await runtime.repos.sessions.createSession({
    id: prepared.session.id,
    userId: user.id,
    tokenHash: prepared.session.tokenHash,
    createdAt: prepared.session.createdAt,
    expiresAt: prepared.session.expiresAt,
    ipHash: prepared.session.ipHash ?? null,
    userAgentHash: prepared.session.userAgentHash ?? null,
  });
  return jsonWithExistingSession(payload, runtime, prepared.rawToken);
}

function jsonWithExistingSession(
  payload: unknown,
  runtime: RuntimeContext,
  rawToken: string,
): Response {
  return json(payload, 200, {
    "Set-Cookie": serializeSessionCookie(
      runtime.cookie,
      rawToken,
      runtime.config.session.maxAgeDays * 24 * 60 * 60,
    ),
  });
}

function sessionConsumeResponseWithToken<T extends { redirectTo: string }>(
  payload: T,
  runtime: RuntimeContext,
  rawToken: string,
  mode: "json" | "form",
): Response {
  const response = jsonWithExistingSession(payload, runtime, rawToken);
  if (mode === "json") return response;
  return redirect(
    payload.redirectTo,
    response.headers.get("Set-Cookie") ?? undefined,
  );
}

function consumeResponse(
  payload: { redirectTo: string },
  mode: "json" | "form",
): Response {
  return mode === "json" ? json(payload) : redirect(payload.redirectTo);
}

async function getSession(
  request: Request,
  runtime: RuntimeContext,
): Promise<SessionWithUserRow | null> {
  const raw = readCookie(request.headers.get("Cookie"), runtime.cookie.name);
  if (!raw) return null;
  try {
    const tokenHash = hashRawAuthToken(raw, runtime.keyRing, "session");
    return runtime.repos.sessions.findSessionByTokenHash(tokenHash, Date.now());
  } catch {
    return null;
  }
}

async function parseBody(
  request: Request,
  runtime: RuntimeContext,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > runtime.config.request.maxBodyBytes)
    throw new AuthCryptoError("Request body too large", "body_too_large");
  const text = await request.text();
  if (Buffer.byteLength(text) > runtime.config.request.maxBodyBytes)
    throw new AuthCryptoError("Request body too large", "body_too_large");
  if (contentType.startsWith("application/json")) {
    try {
      return JSON.parse(text || "{}") as Record<string, unknown>;
    } catch {
      throw new AuthCryptoError("Invalid JSON body", "validation_failed");
    }
  }
  if (contentType.startsWith("application/x-www-form-urlencoded"))
    return Object.fromEntries(new URLSearchParams(text));
  if (!contentType && !text) return {};
  throw new AuthCryptoError(
    "Unsupported content type",
    "unsupported_content_type",
  );
}

async function rateLimit(
  runtime: RuntimeContext,
  action: string,
  subjectType: "ip" | "email" | "identifier",
  subject: string,
  limit: number,
  windowMs: number,
  request: Request,
): Promise<void> {
  const ipKey = deriveRateLimitKey({
    keyRing: runtime.keyRing,
    action,
    subjectType: "ip",
    subject: canonicalizeIp(clientIp(request)),
  });
  const key = deriveRateLimitKey({
    keyRing: runtime.keyRing,
    action,
    subjectType,
    subject: subjectType === "ip" ? canonicalizeIp(subject) : subject,
  });
  const prefilterAllowed = await cloudflareRateLimitPrefilter({
    env: runtime.env,
    key: `${action}:${ipKey}`,
  });
  if (!prefilterAllowed) {
    queueAuthEvent(runtime, request, "rate_limit_hit", {
      metadata: { action, limiter: "cloudflare_prefilter" },
    });
    throw new AuthCryptoError(
      "Too many attempts. Try again later.",
      "rate_limited",
    );
  }
  const first = await runtime.repos.rateLimits.hitFixedWindow({
    action,
    key: ipKey,
    windowMs,
    limit: Math.max(limit, 10),
    now: Date.now(),
  });
  const second = await runtime.repos.rateLimits.hitFixedWindow({
    action,
    key,
    windowMs,
    limit,
    now: Date.now(),
  });
  if (!first.allowed || !second.allowed) {
    queueAuthEvent(runtime, request, "rate_limit_hit", {
      metadata: {
        action,
        limiter: "d1",
        ipLimited: !first.allowed,
        subjectLimited: !second.allowed,
      },
    });
    throw new AuthCryptoError(
      "Too many attempts. Try again later.",
      "rate_limited",
    );
  }
}

function activeTokenPolicy(
  runtime: RuntimeContext,
  type: "magic_link" | "email_verification" | "password_reset",
): ActiveTokenPolicy {
  if (type === "magic_link") return runtime.config.magicLink.activeTokenPolicy;
  if (type === "email_verification")
    return runtime.config.emailVerification.activeTokenPolicy;
  return runtime.config.passwordReset.activeTokenPolicy;
}

function passwordSemaphore(runtime: RuntimeContext): PasswordHashSemaphore {
  const max = runtime.config.passwordHashing.maxConcurrentHashesPerIsolate;
  const key = Number.isInteger(max) && max > 0 ? max : 1;
  let semaphore = hashSemaphores.get(key);
  if (!semaphore) {
    semaphore = new PasswordHashSemaphore(key, 2_000);
    hashSemaphores.set(key, semaphore);
  }
  return semaphore;
}

async function enforceTurnstile(
  runtime: RuntimeContext,
  endpoint: TurnstileEndpointName,
  body: Record<string, unknown>,
  request: Request,
): Promise<void> {
  const { turnstile } = runtime.config;
  if (
    turnstile.mode === "disabled" ||
    !turnstile.endpoints.includes(endpoint)
  ) {
    return;
  }
  const token =
    typeof body.turnstileToken === "string" ? body.turnstileToken.trim() : "";
  if (!token) {
    if (turnstile.mode === "required")
      throw new AuthCryptoError(
        "Turnstile token is required",
        "turnstile_required",
      );
    return;
  }
  const ok = turnstile.verify
    ? await turnstile.verify({
        token,
        request,
        runtime: emailRuntime(runtime),
      })
    : await verifyTurnstileToken({
        token,
        secret: runtime.env.TURNSTILE_SECRET_KEY ?? "",
        remoteIp: clientIp(request),
      });
  if (!ok)
    throw new AuthCryptoError(
      "Turnstile verification failed",
      "turnstile_failed",
    );
}

export async function verifyTurnstileToken(input: {
  token: string;
  secret: string;
  remoteIp?: string;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  if (!input.secret)
    throw new AuthCryptoError(
      "TURNSTILE_SECRET_KEY is missing",
      "config_error",
    );
  const body = new URLSearchParams({
    secret: input.secret,
    response: input.token,
  });
  if (input.remoteIp && input.remoteIp !== "unknown")
    body.set("remoteip", input.remoteIp);
  const response = await (input.fetcher ?? fetch)(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!response.ok) return false;
  const payload = (await response.json()) as { success?: boolean };
  return payload.success === true;
}

export async function cloudflareRateLimitPrefilter(input: {
  env: Record<string, unknown>;
  binding?: string;
  key: string;
}): Promise<boolean> {
  const binding = input.env[input.binding ?? "AUTH_RATE_LIMITER"] as
    | {
        limit(input: { key: string }): Promise<{ success: boolean }>;
      }
    | undefined;
  if (!binding || typeof binding.limit !== "function") return true;
  const result = await binding.limit({ key: input.key });
  return result.success;
}

function resolveRuntime(
  config: AuthConfig,
  request: Request,
  envInput: unknown,
  ctx: ExecutionContext,
): RuntimeContext {
  const env = (envInput ?? {}) as RuntimeEnv;
  const requestUrl = new URL(request.url);
  const mode =
    config.runtime.mode === "from-env" ? env.AUTH_ENV : config.runtime.mode;
  if (!mode) throw new AuthCryptoError("AUTH_ENV is missing", "config_error");
  const publicOrigin =
    config.runtime.publicOrigin === "from-env"
      ? env.AUTH_PUBLIC_ORIGIN
      : config.runtime.publicOrigin;
  if (!publicOrigin && mode !== "development")
    throw new AuthCryptoError("AUTH_PUBLIC_ORIGIN is missing", "config_error");
  const requestOrigin = requestUrl.origin;
  const resolvedPublicOrigin = publicOrigin ?? requestOrigin;
  if (!isExactPublicOriginForMode(resolvedPublicOrigin, mode)) {
    throw new AuthCryptoError(
      "AUTH_PUBLIC_ORIGIN must be an exact origin",
      "config_error",
    );
  }
  if (
    (mode === "production" || mode === "preview") &&
    requestUrl.host !== new URL(resolvedPublicOrigin).host &&
    !config.runtime.trustedHosts.includes(requestUrl.host)
  ) {
    throw new AuthCryptoError("untrusted host", "untrusted_host");
  }
  const db = env[config.database.binding] as D1Database | undefined;
  if (!db) throw new AuthCryptoError("D1 binding is missing", "config_error");
  if (!env.AUTH_SECRET)
    throw new AuthCryptoError("AUTH_SECRET is missing", "config_error");
  const keyRing = parseAuthKeyRing(env.AUTH_SECRET, env.AUTH_SECRET_PREVIOUS);
  return {
    config,
    env,
    ctx,
    mode,
    publicOrigin: resolvedPublicOrigin,
    requestOrigin,
    requestId: request.headers.get("CF-Ray") ?? randomId("req_"),
    db,
    repos: createD1Repositories(db),
    keyRing,
    cookie: resolveSessionCookie({
      mode,
      requestOrigin,
      cookieName: config.session.cookieName,
      sameSite: config.session.sameSite,
      ...(config.session.domain ? { domain: config.session.domain } : {}),
    }),
    logger: consoleLogger,
  };
}

function isExactPublicOriginForMode(
  value: string,
  mode: AuthRuntimeMode,
): boolean {
  if (value.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (value !== url.origin) return false;
  if (url.protocol === "https:") return true;
  return (
    mode === "development" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  );
}

function checkOrigin(request: Request, runtime: RuntimeContext): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.get("Origin");
  if (!origin)
    return (
      runtime.mode === "development" ||
      !runtime.config.request.requireOriginOnUnsafeMethods
    );
  if (origin === runtime.requestOrigin) return true;
  const allowed =
    runtime.mode === "preview"
      ? runtime.config.security.allowedPreviewRequestOrigins
      : runtime.config.security.allowedRequestOrigins;
  return allowed.includes(origin);
}

function handlePreflight(request: Request, runtime: RuntimeContext): Response {
  const origin = request.headers.get("Origin");
  if (!origin)
    return new Response(null, { status: 204, headers: securityHeaders() });
  const allowed =
    origin === runtime.requestOrigin ||
    runtime.config.security.allowedRequestOrigins.includes(origin) ||
    (runtime.mode === "preview" &&
      runtime.config.security.allowedPreviewRequestOrigins.includes(origin));
  if (!allowed)
    return new Response(null, { status: 403, headers: securityHeaders() });
  const headers = securityHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return new Response(null, { status: 204, headers });
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    emailVerified: user.email_verified_at !== null,
    createdAt: user.created_at,
  };
}

function safeRedirect(
  value: string | null | undefined,
  runtime: RuntimeContext,
  defaultRedirect: string,
): string {
  return validateRedirectTarget({
    redirectTo: value,
    requestOrigin: runtime.requestOrigin,
    allowedOrigins:
      runtime.mode === "preview"
        ? runtime.config.redirects.allowedPreviewOrigins
        : runtime.config.redirects.allowedOrigins,
    defaultRedirect,
  });
}

function json(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "application/json");
  for (const [key, value] of Object.entries(extraHeaders ?? {}))
    headers.append(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: unknown, status: number, code: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json(
    { error: { code, message } },
    code === "body_too_large"
      ? 413
      : code === "unsupported_content_type"
        ? 415
        : code === "rate_limited"
          ? 429
          : status,
  );
}

function redirect(location: string, cookie?: string): Response {
  const headers = securityHeaders();
  headers.set("Location", location);
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function html(markup: string): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  );
  return new Response(`<!doctype html><meta charset="utf-8">${markup}`, {
    headers,
  });
}

function securityHeaders(): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`))
    return pathname.slice(basePath.length);
  return null;
}

function contentMode(request: Request): "json" | "form" {
  const type = request.headers.get("Content-Type") ?? "";
  return type.startsWith("application/x-www-form-urlencoded") ? "form" : "json";
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === name) return value.join("=");
  }
  return null;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function emailRuntime(runtime: RuntimeContext): AuthEmailRuntime {
  return {
    env: runtime.env,
    ctx: runtime.ctx,
    mode: runtime.mode,
    requestId: runtime.requestId,
    publicOrigin: runtime.publicOrigin,
    logger: runtime.logger,
  };
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const consoleLogger: AuthLogger = {
  log(message, metadata) {
    console.log(redactLogValue(String(message)), redactMetadata(metadata));
  },
  error(message, metadata) {
    console.error(redactLogValue(String(message)), redactMetadata(metadata));
  },
};

export function redactLogValue(value: string): string {
  return value
    .replace(
      /("[A-Za-z0-9_-]*(?:password|secret|cookie|authorization|api[_-]?key|authToken|token)"\s*:\s*)"[^"]*"/giu,
      '$1"[REDACTED]"',
    )
    .replace(
      /\b((?:password|secret|cookie|authorization|api[_-]?key|authToken|token|AUTH_SECRET|AUTH_SECRET_PREVIOUS)=)[^\s,;&"']+/giu,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(
      /cfauth\.(ses|magic|verify|reset)\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{43}/gu,
      "[REDACTED_TOKEN]",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[REDACTED_EMAIL]",
    );
}

function redactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return JSON.parse(redactLogValue(JSON.stringify(metadata))) as Record<
    string,
    unknown
  >;
}
