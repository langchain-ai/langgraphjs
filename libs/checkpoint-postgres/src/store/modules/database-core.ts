import pg from "pg";
import { TTLConfig, IndexConfig } from "./types.js";

/**
 * Core database operations and connection management.
 * Shared by all modules to avoid duplication.
 */
export class DatabaseCore {
  public readonly pool: pg.Pool;

  public readonly schema: string;

  public readonly ttlConfig?: TTLConfig;

  public readonly indexConfig?: IndexConfig;

  public readonly textSearchLanguage: string;

  constructor(
    pool: pg.Pool,
    schema: string,
    ttlConfig?: TTLConfig,
    indexConfig?: IndexConfig,
    textSearchLanguage?: string
  ) {
    this.pool = pool;
    this.schema = schema;
    this.ttlConfig = ttlConfig;
    this.indexConfig = indexConfig;
    this.textSearchLanguage = textSearchLanguage || "english";
  }

  async withClient<T>(
    operation: (client: pg.PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  calculateExpiresAt(ttl?: number): Date | null {
    const effectiveTtl = ttl ?? this.ttlConfig?.defaultTtl;
    if (!effectiveTtl) return null;
    return new Date(Date.now() + effectiveTtl * 60 * 1000);
  }

  async refreshTtl(
    client: pg.PoolClient,
    namespacePath: string,
    key: string
  ): Promise<void> {
    if (!this.ttlConfig?.refreshOnRead) return;

    const expiresAt = this.calculateExpiresAt();
    if (expiresAt) {
      await client.query(
        `
        UPDATE ${this.schema}.store 
        SET expires_at = $3, updated_at = CURRENT_TIMESTAMP
        WHERE namespace_path = $1 AND key = $2
      `,
        [namespacePath, key, expiresAt]
      );
    }
  }
}
