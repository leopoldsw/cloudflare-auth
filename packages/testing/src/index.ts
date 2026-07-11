import { createRequire } from "node:module";
import type {
  DatabaseSync as DatabaseSyncType,
  StatementSync,
} from "node:sqlite";
import type { AuthEmailAdapter, SendAuthEmailInput } from "@cf-auth/worker";

export const testingPackageName = "@cf-auth/testing";

const requireNode = createRequire(`${process.cwd()}/package.json`);
const { DatabaseSync } = requireNode("node:sqlite") as {
  DatabaseSync: new (filename: string) => DatabaseSyncType;
};

type BoundValue = string | number | null;

class SqliteD1PreparedStatement {
  constructor(
    private readonly database: DatabaseSyncType,
    private readonly sql: string,
    private readonly params: BoundValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1PreparedStatement(
      this.database,
      this.sql,
      values.map(toBoundValue),
    ) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.statement().get(...this.params) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] ?? null) as T;
    return row as T;
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.statement().run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(result.changes),
        changed_db: true,
      },
      results: [],
    } as unknown as D1Result<T>;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return {
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: 0,
        changed_db: false,
      },
      results: this.statement().all(...this.params) as T[],
    } as unknown as D1Result<T>;
  }

  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const rows = this.statement().all(...this.params) as Record<
      string,
      unknown
    >[];
    const values = rows.map((row) => Object.values(row)) as T[];
    if (options?.columnNames) {
      const names = rows[0] ? Object.keys(rows[0]) : [];
      return [names, ...values];
    }
    return values;
  }

  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

class SqliteD1Database {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly sqlite: DatabaseSyncType) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(
      this.sqlite,
      query,
    ) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    const run = async () => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          if (!(statement instanceof SqliteD1PreparedStatement)) {
            throw new Error(
              "SqliteD1Database can only batch its own statements",
            );
          }
          if (/^\s*select\b/i.test(statement["sql"])) {
            results.push((await statement.all<T>()) as D1Result<T>);
          } else {
            results.push((await statement.run<T>()) as D1Result<T>);
          }
        }
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async exec<T = unknown>(query: string): Promise<D1ExecResult> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 } as D1ExecResult;
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  withSession(): D1DatabaseSession {
    return this as unknown as D1DatabaseSession;
  }
}

export function createSqliteD1Database(): D1Database & {
  sqlite: DatabaseSyncType;
} {
  return new SqliteD1Database(new DatabaseSync(":memory:")) as D1Database & {
    sqlite: DatabaseSyncType;
  };
}

export async function applyD1Migrations(
  db: D1Database,
  migrations: string[],
): Promise<void> {
  for (const sql of migrations) {
    await db.exec(sql);
  }
}

export interface MockAuthEmail extends SendAuthEmailInput {
  type: "magic" | "verify" | "reset";
}

export function createMockEmailAdapter(): AuthEmailAdapter & {
  messages: MockAuthEmail[];
} {
  const messages: MockAuthEmail[] = [];
  return {
    kind: "mock",
    messages,
    async sendMagicLink(input) {
      messages.push({ ...input, type: "magic" });
    },
    async sendEmailVerification(input) {
      messages.push({ ...input, type: "verify" });
    },
    async sendPasswordReset(input) {
      messages.push({ ...input, type: "reset" });
    },
  };
}

function toBoundValue(value: unknown): BoundValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError(`Unsupported SQLite D1 bound value: ${typeof value}`);
}
