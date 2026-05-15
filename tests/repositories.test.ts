import { AuthRepositoryError } from "@cf-auth/core";
import { createSqliteD1Database } from "@cf-auth/testing";
import { cleanCfAuth, createD1Repositories } from "@cf-auth/worker";
import { beforeEach, describe, expect, it } from "vitest";

import {
  applyRootD1Migrations,
  rootMigrationVersions,
  rootSchemaVersion,
} from "./migration-helpers.js";

const sessionHash =
  "hmac-sha256$v=1$kid=k1$purpose=session$hash=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const sessionHash2 =
  "hmac-sha256$v=1$kid=k1$purpose=session$hash=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const magicHash =
  "hmac-sha256$v=1$kid=k1$purpose=magic_link$hash=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const magicHash2 =
  "hmac-sha256$v=1$kid=k1$purpose=magic_link$hash=DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const resetHash =
  "hmac-sha256$v=1$kid=k1$purpose=password_reset$hash=EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
const verifyHash =
  "hmac-sha256$v=1$kid=k1$purpose=email_verification$hash=FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";

async function migratedDb() {
  const db = createSqliteD1Database();
  await applyRootD1Migrations(db);
  return db;
}

describe("D1 migrations and repositories", () => {
  let db: D1Database;
  let repos: ReturnType<typeof createD1Repositories>;

  beforeEach(async () => {
    db = await migratedDb();
    repos = createD1Repositories(db);
  });

  it("tracks schema metadata", async () => {
    await expect(
      db
        .prepare("SELECT value FROM auth_meta WHERE key = 'schema_version'")
        .first("value"),
    ).resolves.toBe(await rootSchemaVersion());
    const migrations = await db
      .prepare("SELECT version FROM auth_schema_migrations ORDER BY version")
      .all<{ version: string }>();
    expect(migrations.results?.map((row) => row.version)).toEqual(
      await rootMigrationVersions(),
    );
  });

  it("uses first-primary D1 sessions for auth state lookups", async () => {
    const sessionModes: string[] = [];
    const statement = {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
    } as unknown as D1PreparedStatement;
    const sessionDb = {
      prepare() {
        return statement;
      },
    };
    const primaryAwareDb = {
      prepare() {
        return statement;
      },
      withSession(mode: string) {
        sessionModes.push(mode);
        return sessionDb;
      },
    } as unknown as D1Database;
    const primaryRepos = createD1Repositories(primaryAwareDb);

    await primaryRepos.users.findUserById("usr_primary");
    await primaryRepos.users.findUserByNormalizedEmail("primary@example.com");
    await primaryRepos.users.findUserByNormalizedUsername("primary");
    await primaryRepos.sessions.findSessionByTokenHash(sessionHash, 1);
    await primaryRepos.verificationTokens.findActiveVerificationTokenByHash(
      magicHash,
      "magic_link",
      1,
    );

    expect(sessionModes).toEqual([
      "first-primary",
      "first-primary",
      "first-primary",
      "first-primary",
      "first-primary",
    ]);
  });

  it("enforces unique normalized email and username", async () => {
    await repos.users.createUser({
      id: "usr_one",
      email: "Person@example.com",
      normalizedEmail: "person@example.com",
      username: "person",
      normalizedUsername: "person",
      createdAt: 100,
    });

    await expect(
      repos.users.createUser({
        id: "usr_two",
        email: "Other@example.com",
        normalizedEmail: "person@example.com",
        username: "other",
        normalizedUsername: "other",
        createdAt: 101,
      }),
    ).rejects.toThrow();

    await expect(
      repos.users.createUser({
        id: "usr_three",
        email: "three@example.com",
        normalizedEmail: "three@example.com",
        username: "Person",
        normalizedUsername: "person",
        createdAt: 102,
      }),
    ).rejects.toThrow();
  });

  it("creates, reads, expires, and revokes HMAC-backed sessions", async () => {
    await createUser("usr_session");
    const session = await repos.sessions.createSession({
      id: "ses_one",
      userId: "usr_session",
      tokenHash: sessionHash,
      createdAt: 100,
      expiresAt: 1_000,
    });
    expect(session.token_hash).toBe(sessionHash);
    expect(JSON.stringify(session)).not.toContain("cfauth.ses");

    await expect(
      repos.sessions.findSessionByTokenHash(sessionHash, 200),
    ).resolves.toMatchObject({
      id: "ses_one",
      user: { id: "usr_session" },
    });
    await expect(
      repos.sessions.findSessionByTokenHash(sessionHash, 1_001),
    ).resolves.toBeNull();
    await repos.sessions.revokeSession("ses_one", 300);
    await expect(
      repos.sessions.findSessionByTokenHash(sessionHash, 301),
    ).resolves.toBeNull();
  });

  it("creates token rows from fixture HMAC envelopes and consumes once", async () => {
    await createUser("usr_token");
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_one",
      userId: "usr_token",
      type: "magic_link",
      tokenHash: magicHash,
      redirectTo: "/dashboard",
      createdAt: 100,
      expiresAt: 1_000,
    });

    const consumed = await repos.verificationTokens.consumeVerificationToken({
      tokenHash: magicHash,
      type: "magic_link",
      consumeId: "con_one",
      consumedAt: 200,
      now: 200,
    });
    expect(consumed).toMatchObject({
      id: "vtok_one",
      used_at: 200,
      consume_id: "con_one",
    });
    await expect(
      repos.verificationTokens.consumeVerificationToken({
        tokenHash: magicHash,
        type: "magic_link",
        consumeId: "con_two",
        consumedAt: 201,
        now: 201,
      }),
    ).resolves.toBeNull();
    expect(JSON.stringify(consumed)).not.toContain("cfauth.magic");
  });

  it("consumes token flows with user and session state in one batch", async () => {
    await createUser("usr_flow");
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_magic_flow",
      userId: "usr_flow",
      type: "magic_link",
      tokenHash: magicHash,
      redirectTo: "/dashboard",
      createdAt: 100,
      expiresAt: 1_000,
    });

    const magic =
      await repos.verificationTokens.consumeMagicLinkAndCreateSession({
        tokenHash: magicHash,
        consumeId: "con_magic_flow",
        consumedAt: 200,
        now: 200,
        session: {
          id: "ses_magic_flow",
          tokenHash: sessionHash,
          createdAt: 200,
          expiresAt: 1_000,
        },
      });
    expect(magic).toMatchObject({
      redirectTo: "/dashboard",
      user: { id: "usr_flow", email_verified_at: 200 },
      session: { id: "ses_magic_flow", token_hash: sessionHash },
    });
    await expect(
      repos.verificationTokens.consumeMagicLinkAndCreateSession({
        tokenHash: magicHash,
        consumeId: "con_magic_replay",
        consumedAt: 201,
        now: 201,
        session: {
          id: "ses_magic_replay",
          tokenHash: sessionHash2,
          createdAt: 201,
          expiresAt: 1_001,
        },
      }),
    ).resolves.toBeNull();

    await repos.verificationTokens.createVerificationToken({
      id: "vtok_verify_flow",
      userId: "usr_flow",
      type: "email_verification",
      tokenHash: verifyHash,
      createdAt: 210,
      expiresAt: 1_000,
    });
    const verified = await repos.verificationTokens.consumeEmailVerification({
      tokenHash: verifyHash,
      consumeId: "con_verify_flow",
      consumedAt: 220,
      now: 220,
      verifiedAt: 220,
      updatedAt: 220,
      session: {
        id: "ses_verify_flow",
        tokenHash: sessionHash2,
        createdAt: 220,
        expiresAt: 1_020,
      },
    });
    expect(verified).toMatchObject({
      user: { id: "usr_flow", email_verified_at: 200 },
      session: { id: "ses_verify_flow", token_hash: sessionHash2 },
    });
  });

  it("atomically creates a magic-link JIT user and session", async () => {
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_jit",
      normalizedEmail: "jit-repo@example.com",
      type: "magic_link",
      tokenHash: magicHash,
      createdAt: 100,
      expiresAt: 1_000,
    });

    const consumed =
      await repos.verificationTokens.consumeMagicLinkAndCreateSession({
        tokenHash: magicHash,
        consumeId: "con_jit",
        consumedAt: 200,
        now: 200,
        jitUser: { id: "usr_jit", createdAt: 200 },
        session: {
          id: "ses_jit",
          tokenHash: sessionHash,
          createdAt: 200,
          expiresAt: 1_000,
        },
      });

    expect(consumed).toMatchObject({
      createdUser: true,
      user: {
        id: "usr_jit",
        email: "jit-repo@example.com",
        email_verified_at: 200,
      },
      session: { id: "ses_jit", user_id: "usr_jit" },
      token: { user_id: "usr_jit", normalized_email: null },
    });
  });

  it("does not consume user-bound tokens for disabled users", async () => {
    await repos.users.createUser({
      id: "usr_disabled_token",
      email: "disabled-token@example.com",
      normalizedEmail: "disabled-token@example.com",
      passwordHash: "old-password-hash",
      createdAt: 100,
    });
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_disabled_reset",
      userId: "usr_disabled_token",
      type: "password_reset",
      tokenHash: resetHash,
      createdAt: 110,
      expiresAt: 1_000,
    });
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_disabled_magic_jit",
      normalizedEmail: "disabled-token@example.com",
      type: "magic_link",
      tokenHash: magicHash,
      createdAt: 111,
      expiresAt: 1_000,
    });
    await repos.users.setUserDisabled("usr_disabled_token", 150);

    await expect(
      repos.verificationTokens.findActiveVerificationTokenByHash(
        resetHash,
        "password_reset",
        200,
      ),
    ).resolves.toBeNull();
    await expect(
      repos.verificationTokens.findActiveDisabledUserByTokenHash(
        resetHash,
        "password_reset",
        200,
      ),
    ).resolves.toMatchObject({ id: "usr_disabled_token" });
    await expect(
      repos.verificationTokens.findActiveDisabledUserByTokenHash(
        magicHash,
        "magic_link",
        200,
      ),
    ).resolves.toMatchObject({ id: "usr_disabled_token" });
    await expect(
      repos.verificationTokens.consumePasswordReset({
        tokenHash: resetHash,
        consumeId: "con_disabled_reset",
        consumedAt: 200,
        now: 200,
        passwordHash: "new-password-hash",
        updatedAt: 200,
        markEmailVerifiedAt: 200,
        revokeExistingSessionsAt: 200,
      }),
    ).resolves.toBeNull();
    await expect(
      repos.verificationTokens.consumeVerificationToken({
        tokenHash: resetHash,
        type: "password_reset",
        consumeId: "con_disabled_generic",
        consumedAt: 201,
        now: 201,
      }),
    ).resolves.toBeNull();
    await expect(
      db
        .prepare(
          "SELECT used_at, consume_id FROM verification_tokens WHERE id = ?",
        )
        .bind("vtok_disabled_reset")
        .first(),
    ).resolves.toMatchObject({ used_at: null, consume_id: null });
    await expect(
      db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .bind("usr_disabled_token")
        .first("password_hash"),
    ).resolves.toBe("old-password-hash");
  });

  it("enforces token subject and used/revoked invariants", async () => {
    await createUser("usr_subject");
    await expect(
      repos.verificationTokens.createVerificationToken({
        id: "vtok_bad_subject",
        type: "password_reset",
        normalizedEmail: "person@example.com",
        tokenHash: resetHash,
        createdAt: 100,
        expiresAt: 1_000,
      }),
    ).rejects.toBeInstanceOf(AuthRepositoryError);
    await expect(
      repos.verificationTokens.createVerificationToken({
        id: "vtok_magic_no_subject",
        type: "magic_link",
        tokenHash: magicHash,
        createdAt: 100,
        expiresAt: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_token_subject" });
    await expect(
      repos.verificationTokens.createVerificationToken({
        id: "vtok_magic_two_subjects",
        userId: "usr_subject",
        normalizedEmail: "person@example.com",
        type: "magic_link",
        tokenHash: magicHash,
        createdAt: 100,
        expiresAt: 1_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_token_subject" });
    await expect(
      db
        .prepare(
          `INSERT INTO verification_tokens (
            id, user_id, normalized_email, token_hash, type, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "vtok_schema_bad_subject",
          null,
          "person@example.com",
          verifyHash,
          "email_verification",
          100,
          1_000,
        )
        .run(),
    ).rejects.toThrow();

    await repos.verificationTokens.createVerificationToken({
      id: "vtok_reset",
      userId: "usr_subject",
      type: "password_reset",
      tokenHash: resetHash,
      createdAt: 100,
      expiresAt: 1_000,
    });

    await expect(
      db
        .prepare(
          "UPDATE verification_tokens SET used_at = ?, consume_id = ?, revoked_at = ?, revoked_reason = ? WHERE id = ?",
        )
        .bind(200, "con_bad", 201, "bad", "vtok_reset")
        .run(),
    ).rejects.toThrow();
  });

  it("rejects expired tokens and revokes previous active tokens without marking them used", async () => {
    await createUser("usr_revoke");
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_old",
      userId: "usr_revoke",
      type: "magic_link",
      tokenHash: magicHash,
      createdAt: 100,
      expiresAt: 150,
    });
    await expect(
      repos.verificationTokens.consumeVerificationToken({
        tokenHash: magicHash,
        type: "magic_link",
        consumeId: "con_expired",
        consumedAt: 200,
        now: 200,
      }),
    ).resolves.toBeNull();

    await repos.verificationTokens.createVerificationToken({
      id: "vtok_new",
      userId: "usr_revoke",
      type: "magic_link",
      tokenHash: magicHash2,
      createdAt: 210,
      expiresAt: 1_000,
    });
    const revoked =
      await repos.verificationTokens.revokeActiveVerificationTokens({
        userId: "usr_revoke",
        type: "magic_link",
        revokedAt: 220,
        revokedReason: "superseded",
      });
    expect(revoked).toBe(2);
    const rows = await db
      .prepare(
        "SELECT id, used_at, revoked_at, revoked_reason FROM verification_tokens",
      )
      .all<{
        id: string;
        used_at: number | null;
        revoked_at: number | null;
        revoked_reason: string | null;
      }>();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "vtok_old",
          used_at: null,
          revoked_at: 220,
          revoked_reason: "superseded",
        }),
        expect.objectContaining({
          id: "vtok_new",
          used_at: null,
          revoked_at: 220,
          revoked_reason: "superseded",
        }),
      ]),
    );
  });

  it("validates metadata JSON constraints", async () => {
    await expect(
      repos.users.createUser({
        id: "usr_bad_json",
        email: "bad@example.com",
        normalizedEmail: "bad@example.com",
        createdAt: 100,
        metadataJson: "[]",
      }),
    ).rejects.toThrow(AuthRepositoryError);

    await expect(
      db
        .prepare(
          "INSERT INTO users (id, email, normalized_email, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          "usr_invalid_json",
          "bad@example.com",
          "bad@example.com",
          100,
          100,
          "{",
        )
        .run(),
    ).rejects.toThrow();
  });

  it("cleans closed auth rows with scheduled cleanup defaults", async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    await createUser("usr_cleanup");
    await repos.sessions.createSession({
      id: "ses_cleanup_old",
      userId: "usr_cleanup",
      tokenHash: sessionHash,
      createdAt: 1,
      expiresAt: now - 8 * day,
    });
    await repos.sessions.createSession({
      id: "ses_cleanup_live",
      userId: "usr_cleanup",
      tokenHash: sessionHash2,
      createdAt: 1,
      expiresAt: now + day,
    });
    await repos.verificationTokens.createVerificationToken({
      id: "vtok_cleanup_old",
      userId: "usr_cleanup",
      type: "magic_link",
      tokenHash: magicHash,
      createdAt: 1,
      expiresAt: now - 8 * day,
    });
    await repos.rateLimits.hitFixedWindow({
      action: "cleanup",
      key: "rl:v1:cleanup:ip:GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG",
      windowMs: 1,
      limit: 1,
      now: now - 2 * day,
    });
    await repos.events.writeAuthEvent({
      id: "evt_cleanup_old",
      eventType: "cleanup_old",
      createdAt: now - 91 * day,
      metadataJson: "{}",
    });
    await repos.events.writeAuthEvent({
      id: "evt_cleanup_live",
      eventType: "cleanup_live",
      createdAt: now - day,
      metadataJson: "{}",
    });

    await expect(
      cleanCfAuth({
        env: { AUTH_DB: db },
        config: { appName: "Cleanup Test", basePath: "/auth" },
        now,
      }),
    ).resolves.toEqual({
      sessions: 1,
      verificationTokens: 1,
      rateLimits: 1,
      authEvents: 1,
    });
    await expect(
      db.prepare("SELECT id FROM sessions ORDER BY id").all<{ id: string }>(),
    ).resolves.toMatchObject({ results: [{ id: "ses_cleanup_live" }] });
    await expect(
      db.prepare("SELECT id FROM verification_tokens").first("id"),
    ).resolves.toBeNull();
    await expect(
      db.prepare("SELECT key FROM rate_limits").first("key"),
    ).resolves.toBeNull();
    await expect(
      db
        .prepare("SELECT id FROM auth_events ORDER BY id")
        .all<{ id: string }>(),
    ).resolves.toMatchObject({ results: [{ id: "evt_cleanup_live" }] });
    await expect(
      cleanCfAuth({
        env: { AUTH_DB: db },
        config: { appName: "Cleanup Test", basePath: "/auth" },
        retention: { authEventMs: -1 },
      }),
    ).rejects.toThrow("invalid cleanup retention authEventMs");
    for (const invalidNow of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        cleanCfAuth({
          env: { AUTH_DB: db },
          config: { appName: "Cleanup Test", basePath: "/auth" },
          now: invalidNow,
        }),
      ).rejects.toThrow("invalid cleanup now");
    }
  });

  it("isolates D1 rate limits by action and opaque derived key", async () => {
    const opaque =
      "rl:v1:password_login:email:FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF";
    const first = await repos.rateLimits.hitFixedWindow({
      action: "password_login",
      key: opaque,
      windowMs: 1_000,
      limit: 1,
      now: 100,
    });
    const second = await repos.rateLimits.hitFixedWindow({
      action: "magic_link_request",
      key: opaque.replace("password_login", "magic_link_request"),
      windowMs: 1_000,
      limit: 1,
      now: 100,
    });
    const third = await repos.rateLimits.hitFixedWindow({
      action: "password_login",
      key: opaque,
      windowMs: 1_000,
      limit: 1,
      now: 101,
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    const rows = await db
      .prepare("SELECT key FROM rate_limits")
      .all<{ key: string }>();
    expect(rows.results?.every((row) => row.key.startsWith("rl:v1:"))).toBe(
      true,
    );
    expect(JSON.stringify(rows.results)).not.toMatch(
      /person@example\.com|127\.0\.0\.1/,
    );
  });

  async function createUser(id: string) {
    return repos.users.createUser({
      id,
      email: `${id}@example.com`,
      normalizedEmail: `${id}@example.com`,
      createdAt: 100,
    });
  }
});
