import type { SqlBackend, SqlRow } from "../backend.js";

/**
 * Cloudflare Durable Object SQLite backend.
 *
 * Expects `ctx.storage` from within a Durable Object class.
 * Uses `storage.sql` for queries and `storage.transactionSync()` for transactions
 * (DO does not allow raw BEGIN/COMMIT SQL statements).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DurableObjectStorage = any;

export class DurableObjectBackend implements SqlBackend {
  private storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }

  queryAll<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.storage.sql.exec(sql, ...params).toArray() as T[];
  }

  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    const rows = this.storage.sql.exec(sql, ...params).toArray() as T[];
    return rows[0];
  }

  execute(sql: string, ...params: unknown[]): void {
    this.storage.sql.exec(sql, ...params);
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
