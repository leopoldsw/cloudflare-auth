import { readFile } from "node:fs/promises";

import { AuthRepositoryError } from "@cf-auth/core";
import { createSqliteD1Database, applyD1Migrations } from "@cf-auth/testing";
import { createD1Repositories } from "@cf-auth/worker";
import { beforeEach, describe, expect, it } from "vitest";

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

async function migratedDb() {
  const db = createSqliteD1Database();
  await applyD1Migrations(db, [
    await readFile("migrations/0001_initial.sql", "utf8"),
    await readFile("migrations/0002_indexes.sql", "utf8"),
  ]);
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
    ).resolves.toBe("2");
    const migrations = await db
      .prepare("SELECT version FROM auth_schema_migrations ORDER BY version")
      .all<{ version: string }>();
    expect(migrations.results?.map((row) => row.version)).toEqual([
      "0001",
      "0002",
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
