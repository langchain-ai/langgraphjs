export interface SqlRow {
  [key: string]: unknown;
}

/**
 * Minimal SQL interface that both Cloudflare DO SQLite and better-sqlite3 can implement.
 * All methods are synchronous — async wrapping happens in the saver class.
 */
export interface SqlBackend {
  queryAll<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T[];

  queryOne<T extends SqlRow = SqlRow>(
    sql: string,
    ...params: unknown[]
  ): T | undefined;

  execute(sql: string, ...params: unknown[]): void;

  transaction<T>(fn: () => T): T;
}
