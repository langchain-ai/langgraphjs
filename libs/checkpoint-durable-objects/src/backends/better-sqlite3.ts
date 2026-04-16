import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { SqlBackend, SqlRow } from "../backend.js";

export class BetterSqliteBackend implements SqlBackend {
  db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
    this.db.pragma("journal_mode=WAL");
  }

  static fromConnString(connString: string): BetterSqliteBackend {
    return new BetterSqliteBackend(new Database(connString));
  }

  queryAll<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  execute(sql: string, ...params: unknown[]): void {
    if (params.length === 0) {
      this.db.exec(sql);
    } else {
      this.db.prepare(sql).run(...params);
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
