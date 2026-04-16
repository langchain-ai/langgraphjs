import type { SqlBackend, SqlRow } from "../backend.js";

/**
 * Cloudflare Durable Object SQLite backend.
 *
 * Expects `ctx.storage.sql` from within a Durable Object class.
 * The SqlStorage API: sql.exec(query, ...bindings) returns a cursor with
 * .toArray(), .one(), .raw() methods.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlStorage = any; // DurableObjectStorage["sql"] from @cloudflare/workers-types

export class DurableObjectBackend implements SqlBackend {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  queryAll<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.sql.exec(sql, ...params).toArray() as T[];
  }

  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    const rows = this.sql.exec(sql, ...params).toArray() as T[];
    return rows[0];
  }

  execute(sql: string, ...params: unknown[]): void {
    this.sql.exec(sql, ...params);
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN");
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}
