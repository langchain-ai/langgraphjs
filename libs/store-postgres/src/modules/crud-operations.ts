import pg from "pg";
import {
  type Item,
  type GetOperation,
  type PutOperation,
} from "@langchain/langgraph-checkpoint";
import { DatabaseCore } from "./database-core.js";
import { VectorOperations } from "./vector-operations.js";
import { PutOptions } from "./types.js";
import { validateNamespace } from "./utils.js";

/**
 * Handles basic CRUD operations: get, put, delete.
 */
export class CrudOperations {
  constructor(
    private core: DatabaseCore,
    private vectorOps: VectorOperations
  ) {}

  async executeGet(
    client: pg.PoolClient,
    operation: GetOperation
  ): Promise<Item | null> {
    validateNamespace(operation.namespace);

    const namespacePath = operation.namespace.join(":");

    const result = await client.query(
      `
      SELECT namespace_path, key, value, created_at, updated_at
      FROM ${this.core.schema}.store
      WHERE namespace_path = $1 AND key = $2
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `,
      [namespacePath, operation.key]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];

    // Refresh TTL if configured
    if (this.core.ttlConfig?.refreshOnRead) {
      await this.core.refreshTtl(client, namespacePath, operation.key);
    }

    return {
      namespace: row.namespace_path.split(":"),
      key: row.key,
      value: row.value,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async executePut(
    client: pg.PoolClient,
    operation: PutOperation
  ): Promise<void> {
    validateNamespace(operation.namespace);

    const namespacePath = operation.namespace.join(":");
    const { key, value } = operation;

    if (value === null) {
      // Delete operation
      await client.query(
        `
        DELETE FROM ${this.core.schema}.store
        WHERE namespace_path = $1 AND key = $2
      `,
        [namespacePath, key]
      );
    } else {
      // Insert or update operation
      const expiresAt = this.core.calculateExpiresAt();

      await client.query(
        `
        INSERT INTO ${this.core.schema}.store (namespace_path, key, value, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (namespace_path, key)
        DO UPDATE SET 
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = CURRENT_TIMESTAMP
      `,
        [namespacePath, key, value, expiresAt]
      );

      // Handle vector indexing if configured
      if (this.core.indexConfig) {
        await this.vectorOps.indexItemVectors(
          client,
          namespacePath,
          key,
          value
        );
      }
    }
  }

  async putAdvanced(
    namespace: string[],
    key: string,
    value: Record<string, unknown> | null,
    options: PutOptions = {}
  ): Promise<void> {
    await this.core.withClient(async (client) => {
      validateNamespace(namespace);

      const namespacePath = namespace.join(":");

      if (value === null) {
        await client.query(
          `
          DELETE FROM ${this.core.schema}.store
          WHERE namespace_path = $1 AND key = $2
        `,
          [namespacePath, key]
        );
      } else {
        const expiresAt = this.core.calculateExpiresAt(options.ttl);

        await client.query(
          `
          INSERT INTO ${this.core.schema}.store (namespace_path, key, value, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (namespace_path, key)
          DO UPDATE SET 
            value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = CURRENT_TIMESTAMP
        `,
          [namespacePath, key, JSON.stringify(value), expiresAt]
        );
      }
    });
  }
}
