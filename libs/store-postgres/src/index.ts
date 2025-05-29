import pg from "pg";
import {
  BaseStore,
  type Operation,
  type OperationResults,
  type ListNamespacesOperation,
} from "@langchain/langgraph-checkpoint";

// Import types
import {
  PostgresStoreConfig,
  SearchOptions,
  SearchItem,
  PutOptions,
} from "./modules/types.js";

// Import modules
import { DatabaseCore } from "./modules/database-core.js";
import { DatabaseSetup } from "./modules/database-setup.js";
import { VectorOperations } from "./modules/vector-operations.js";
import { CrudOperations } from "./modules/crud-operations.js";
import { SearchOperations } from "./modules/search-operations.js";
import { TTLManager } from "./modules/ttl-manager.js";

// Re-export types for convenience
export * from "./modules/types.js";

const { Pool } = pg;

/**
 * PostgreSQL implementation of the BaseStore interface.
 * This is now a lightweight orchestrator that delegates to specialized modules.
 */
export class PostgresStore extends BaseStore {
  private core: DatabaseCore;

  private dbSetup: DatabaseSetup;

  private vectorOps: VectorOperations;

  private crudOps: CrudOperations;

  private searchOps: SearchOperations;

  private ttlManager: TTLManager;

  private isSetup: boolean = false;

  private isClosed: boolean = false;

  private ensureTables: boolean;

  constructor(config: PostgresStoreConfig) {
    super();

    // Create connection pool
    const pool =
      typeof config.connectionOptions === "string"
        ? new Pool({ connectionString: config.connectionOptions })
        : new Pool(config.connectionOptions);

    // Initialize core and modules
    this.core = new DatabaseCore(
      pool,
      config.schema || "public",
      config.ttl,
      config.index
    );

    this.dbSetup = new DatabaseSetup(this.core);
    this.vectorOps = new VectorOperations(this.core);
    this.crudOps = new CrudOperations(this.core, this.vectorOps);
    this.searchOps = new SearchOperations(this.core, this.vectorOps);
    this.ttlManager = new TTLManager(this.core);

    this.ensureTables = config.ensureTables ?? true;
  }

  /**
   * Creates a PostgresStore instance from a connection string.
   */
  static fromConnectionString(
    connectionString: string,
    options?: Omit<PostgresStoreConfig, "connectionOptions">
  ): PostgresStore {
    return new PostgresStore({
      connectionOptions: connectionString,
      ...options,
    });
  }

  /**
   * Initialize the store by creating necessary tables and indexes.
   */
  async setup(): Promise<void> {
    if (this.isSetup) return;

    await this.dbSetup.initialize();
    this.isSetup = true;

    // Start TTL sweeper if configured
    if (this.core.ttlConfig?.sweepIntervalMinutes) {
      this.ttlManager.start();
    }
  }

  /**
   * Execute multiple operations in a single batch.
   */
  async batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    return this.core.withClient(async (client) => {
      const results: unknown[] = [];

      for (const operation of operations) {
        if ("namespacePrefix" in operation) {
          // SearchOperation
          results.push(await this.searchOps.executeSearch(client, operation));
        } else if ("key" in operation && !("value" in operation)) {
          // GetOperation
          results.push(await this.crudOps.executeGet(client, operation));
        } else if ("value" in operation) {
          // PutOperation
          results.push(await this.crudOps.executePut(client, operation));
        } else if ("matchConditions" in operation) {
          // ListNamespacesOperation
          results.push(await this.executeListNamespaces(client, operation));
        } else {
          throw new Error(
            `Unsupported operation type: ${JSON.stringify(operation)}`
          );
        }
      }

      return results as OperationResults<Op>;
    });
  }

  private async executeListNamespaces(
    client: pg.PoolClient,
    operation: ListNamespacesOperation
  ): Promise<string[][]> {
    const { matchConditions, maxDepth, limit = 100, offset = 0 } = operation;

    let sqlQuery = `
      SELECT DISTINCT namespace_path
      FROM ${this.core.schema}.store
    `;

    const params: unknown[] = [];
    const conditions: string[] = [];
    let paramIndex = 1;

    // Add match conditions
    if (matchConditions && matchConditions.length > 0) {
      for (const condition of matchConditions) {
        if (condition.matchType === "prefix") {
          const prefix = condition.path.join(":");
          conditions.push(`namespace_path LIKE $${paramIndex}`);
          params.push(`${prefix}%`);
          paramIndex += 1;
        } else if (condition.matchType === "suffix") {
          const suffix = condition.path.join(":");
          conditions.push(`namespace_path LIKE $${paramIndex}`);
          params.push(`%${suffix}`);
          paramIndex += 1;
        }
      }
    }

    if (conditions.length > 0) {
      sqlQuery += ` WHERE ${conditions.join(" AND ")}`;
    }

    sqlQuery += ` ORDER BY namespace_path LIMIT $${paramIndex} OFFSET $${
      paramIndex + 1
    }`;
    params.push(limit, offset);

    const result = await client.query(sqlQuery, params);

    let namespaces = result.rows.map((row) => row.namespace_path.split(":"));

    // Apply maxDepth filter if specified
    if (maxDepth !== undefined) {
      namespaces = namespaces.filter((ns) => ns.length <= maxDepth);
    }

    return namespaces;
  }

  /**
   * Start the store. Calls setup() if ensureTables is true.
   */
  start(): void {
    if (this.ensureTables && !this.isSetup) {
      this.setup().catch((error) => {
        console.error("Failed to setup PostgresStore:", error);
      });
    }
  }

  /**
   * Stop the store and close all database connections.
   */
  stop(): void {
    if (this.isClosed) return;

    this.ttlManager.stop();
    this.core.pool.end().catch((error) => {
      console.error("Error closing PostgreSQL pool:", error);
    });
    this.isClosed = true;
  }

  /**
   * Close all database connections.
   */
  async end(): Promise<void> {
    if (this.isClosed) return;

    this.ttlManager.stop();
    await this.core.pool.end();
    this.isClosed = true;
  }

  /**
   * Manually sweep expired items from the store.
   */
  async sweepExpiredItems(): Promise<number> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }
    return this.ttlManager.sweepExpiredItems();
  }

  /**
   * Enhanced search with advanced filtering and similarity scoring.
   */
  async searchAdvanced(
    namespacePrefix: string[],
    options: SearchOptions = {}
  ): Promise<SearchItem[]> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }
    return this.searchOps.searchAdvanced(namespacePrefix, options);
  }

  /**
   * Put an item with advanced options including TTL.
   */
  async putAdvanced(
    namespace: string[],
    key: string,
    value: Record<string, unknown> | null,
    options: PutOptions = {}
  ): Promise<void> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }
    return this.crudOps.putAdvanced(namespace, key, value, options);
  }

  /**
   * Get statistics about the store.
   */
  async getStats(): Promise<{
    totalItems: number;
    expiredItems: number;
    namespaceCount: number;
    oldestItem: Date | null;
    newestItem: Date | null;
  }> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    return this.core.withClient(async (client) => {
      const result = await client.query(`
        SELECT 
          COUNT(*) as total_items,
          COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 1 END) as expired_items,
          COUNT(DISTINCT namespace_path) as namespace_count,
          MIN(created_at) as oldest_item,
          MAX(created_at) as newest_item
        FROM ${this.core.schema}.store
      `);

      const row = result.rows[0];
      return {
        totalItems: parseInt(row.total_items, 10),
        expiredItems: parseInt(row.expired_items, 10),
        namespaceCount: parseInt(row.namespace_count, 10),
        oldestItem: row.oldest_item,
        newestItem: row.newest_item,
      };
    });
  }

  /**
   * Enhanced vector similarity search with advanced options.
   */
  async vectorSearch(
    namespacePrefix: string[],
    query: string,
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      similarityThreshold?: number;
      distanceMetric?: "cosine" | "l2" | "inner_product";
    } = {}
  ): Promise<SearchItem[]> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }
    return this.searchOps.vectorSearch(namespacePrefix, query, options);
  }

  /**
   * Hybrid search combining vector similarity and text search.
   */
  async hybridSearch(
    namespacePrefix: string[],
    query: string,
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      vectorWeight?: number;
      similarityThreshold?: number;
    } = {}
  ): Promise<SearchItem[]> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }
    return this.searchOps.hybridSearch(namespacePrefix, query, options);
  }

  /**
   * Search for items in the store with basic options.
   *
   * @param namespacePrefix - The namespace prefix to search within
   * @param options - Search options including filters, query, pagination
   * @returns Promise resolving to an array of search results with optional similarity scores
   *
   * @example
   * ```typescript
   * // Basic text search
   * const results = await store.search(["documents"], {
   *   query: "machine learning",
   *   limit: 10
   * });
   *
   * // Filtered search
   * const results = await store.search(["products"], {
   *   filter: { category: "electronics", price: { $lt: 100 } },
   *   limit: 20
   * });
   *
   * // Advanced search with operators
   * const results = await store.search(["users"], {
   *   filter: {
   *     age: { $gte: 18, $lt: 65 },
   *     status: { $in: ["active", "pending"] }
   *   }
   * });
   * ```
   */
  async search(
    namespacePrefix: string[],
    options: SearchOptions = {}
  ): Promise<SearchItem[]> {
    // If vector search is configured and query is provided, use vector search
    if (this.core.indexConfig && options.query) {
      return this.vectorSearch(namespacePrefix, options.query, {
        filter: options.filter,
        limit: options.limit,
        offset: options.offset,
      });
    }

    // Otherwise use advanced search (handles text search + filtering)
    return this.searchAdvanced(namespacePrefix, options);
  }
}
