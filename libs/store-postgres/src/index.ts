/* eslint-disable @typescript-eslint/no-explicit-any */
import pg from "pg";
import {
  BaseStore,
  type Item,
  type Operation,
  type OperationResults,
  type GetOperation,
  type PutOperation,
  type SearchOperation,
  type ListNamespacesOperation,
} from "@langchain/langgraph-checkpoint";

const { Pool } = pg;

/**
 * Interface for embedding models.
 * Compatible with LangChain's Embeddings interface.
 */
export interface Embeddings {
  /**
   * Embed search documents.
   */
  embedDocuments(texts: string[]): Promise<number[][]>;
  
  /**
   * Embed query text.
   */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Synchronous embedding function type.
 */
export type EmbeddingsFunc = (texts: string[]) => Promise<number[][]>;

/**
 * Asynchronous embedding function type.
 */
export type AEmbeddingsFunc = (texts: string[]) => Promise<number[][]>;

/**
 * Vector index types supported by pgvector.
 */
export type VectorIndexType = 'ivfflat' | 'hnsw';

/**
 * Distance metrics for vector similarity search.
 */
export type DistanceMetric = 'cosine' | 'l2' | 'inner_product';

/**
 * HNSW index configuration parameters.
 */
export interface HNSWConfig {
  /**
   * Maximum number of connections for each node in the graph.
   * Higher values improve recall but increase memory usage and build time.
   * @default 16
   */
  m?: number;
  
  /**
   * Size of the dynamic candidate list during construction.
   * Higher values improve index quality but increase build time.
   * @default 200
   */
  efConstruction?: number;
  
  /**
   * Size of the dynamic candidate list during search.
   * Higher values improve recall but increase search time.
   * Can be adjusted per query for performance tuning.
   * @default 40
   */
  ef?: number;
}

/**
 * IVFFlat index configuration parameters.
 */
export interface IVFFlatConfig {
  /**
   * Number of inverted lists (clusters).
   * Rule of thumb: sqrt(number_of_rows) for good performance.
   * @default 100
   */
  lists?: number;
  
  /**
   * Number of probes to use during search.
   * Higher values improve recall but increase search time.
   * @default 1
   */
  probes?: number;
}

/**
 * Configuration for indexing documents for semantic search.
 */
export interface IndexConfig {
  /**
   * Number of dimensions in the embedding vectors.
   */
  dims: number;
  
  /**
   * Embedding function to generate embeddings from text.
   * Can be a LangChain Embeddings instance, function, or provider string.
   */
  embed: Embeddings | EmbeddingsFunc | AEmbeddingsFunc | string;
  
  /**
   * Fields to extract text from for embedding generation.
   * Uses JSON path syntax. Defaults to ["$"] (entire document).
   */
  fields?: string[];
  
  /**
   * Vector index type to use.
   * - 'hnsw': Hierarchical Navigable Small World (best for most use cases)
   * - 'ivfflat': Inverted File with Flat compression (good for large datasets)
   * @default 'hnsw'
   */
  indexType?: VectorIndexType;
  
  /**
   * Distance metric for vector similarity.
   * @default 'cosine'
   */
  distanceMetric?: DistanceMetric;
  
  /**
   * HNSW-specific configuration parameters.
   * Only used when indexType is 'hnsw'.
   */
  hnsw?: HNSWConfig;
  
  /**
   * IVFFlat-specific configuration parameters.
   * Only used when indexType is 'ivfflat'.
   */
  ivfflat?: IVFFlatConfig;
  
  /**
   * Whether to create indexes for all distance metrics.
   * If false, only creates index for the specified distanceMetric.
   * @default false
   */
  createAllMetricIndexes?: boolean;
}

/**
 * TTL configuration for the store.
 */
export interface TTLConfig {
  /**
   * Default TTL in minutes for new items.
   */
  defaultTtl?: number;
  
  /**
   * Whether to refresh TTL on read operations by default.
   * @default true
   */
  refreshOnRead?: boolean;
  
  /**
   * Interval in minutes between TTL sweep operations.
   * @default 60
   */
  sweepIntervalMinutes?: number;
}

/**
 * Advanced filter operators for search operations.
 */
export interface FilterOperators {
  $eq?: any;
  $ne?: any;
  $gt?: any;
  $gte?: any;
  $lt?: any;
  $lte?: any;
  $in?: any[];
  $nin?: any[];
  $exists?: boolean;
}

/**
 * Enhanced search item with similarity score.
 */
export interface SearchItem extends Item {
  /**
   * Relevance/similarity score for the search result.
   */
  score?: number;
}

/**
 * Enhanced search options with advanced filtering.
 */
export interface SearchOptions {
  /**
   * Filter conditions with support for advanced operators.
   */
  filter?: Record<string, any | FilterOperators>;
  
  /**
   * Natural language search query.
   */
  query?: string;
  
  /**
   * Maximum number of results to return.
   * @default 10
   */
  limit?: number;
  
  /**
   * Number of results to skip for pagination.
   * @default 0
   */
  offset?: number;
  
  /**
   * Whether to refresh TTL for returned items.
   */
  refreshTtl?: boolean;
}

/**
 * Enhanced put options with TTL support.
 */
export interface PutOptions {
  /**
   * TTL in minutes for this item.
   */
  ttl?: number;
  
  /**
   * Whether to index this item for search.
   * @default true
   */
  index?: boolean;
}

/**
 * Validates the provided namespace.
 * @param namespace The namespace to validate.
 * @throws {Error} If the namespace is invalid.
 */
function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) {
    throw new Error("Namespace cannot be empty.");
  }
  for (const label of namespace) {
    if (typeof label !== "string") {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels ` +
          `must be strings, but got ${typeof label}.`
      );
    }
    if (label.includes(".")) {
      throw new Error(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`
      );
    }
    if (label === "") {
      throw new Error(
        `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`
      );
    }
  }
  if (namespace[0] === "langgraph") {
    throw new Error(
      `Root label for namespace cannot be "langgraph". Got: ${namespace}`
    );
  }
}

/**
 * Configuration options for PostgreSQL store connection.
 */
export interface PostgresStoreConfig {
  /**
   * PostgreSQL connection string or connection configuration object.
   * 
   * @example
   * // Connection string
   * "postgresql://user:password@localhost:5432/database"
   * 
   * // Configuration object
   * {
   *   host: "localhost",
   *   port: 5432,
   *   database: "mydb",
   *   user: "postgres",
   *   password: "password"
   * }
   */
  connectionOptions: string | pg.PoolConfig;

  /**
   * Database schema name to use for store tables.
   * @default "public"
   */
  schema?: string;

  /**
   * Whether to automatically create tables if they don't exist.
   * @default true
   */
  ensureTables?: boolean;

  /**
   * TTL configuration for automatic expiration of items.
   */
  ttl?: TTLConfig;

  /**
   * Vector search configuration for semantic search capabilities.
   * If provided, enables vector similarity search using pgvector extension.
   */
  index?: IndexConfig;
}

/**
 * PostgreSQL implementation of the BaseStore interface.
 * 
 * This store provides persistent key-value storage with hierarchical namespaces,
 * full-text search capabilities, and JSON-based filtering.
 * 
 * @example
 * ```typescript
 * import { PostgresStore } from "@langchain/langgraph-store-postgres";
 * 
 * // Basic usage
 * const store = new PostgresStore({
 *   connectionOptions: "postgresql://user:password@localhost:5432/database"
 * });
 * 
 * await store.setup();
 * 
 * // Store data
 * await store.put(["documents"], "doc1", { 
 *   title: "My Document", 
 *   content: "Document content" 
 * });
 * 
 * // Retrieve data
 * const item = await store.get(["documents"], "doc1");
 * console.log(item?.value); // { title: "My Document", content: "Document content" }
 * 
 * // Search
 * const results = await store.search(["documents"], { 
 *   filter: { title: "My Document" } 
 * });
 * ```
 */
export class PostgresStore extends BaseStore {
  private pool: pg.Pool;

  private schema: string;

  private ensureTables: boolean;

  private isSetup: boolean = false;

  private ttlConfig?: TTLConfig;

  private ttlSweepInterval?: NodeJS.Timeout;

  private indexConfig?: IndexConfig;

  private isClosed: boolean = false;

  constructor(config: PostgresStoreConfig) {
    super();
    
    if (typeof config.connectionOptions === "string") {
      this.pool = new Pool({ connectionString: config.connectionOptions });
    } else {
      this.pool = new Pool(config.connectionOptions);
    }
    
    this.schema = config.schema || "public";
    this.ensureTables = config.ensureTables ?? true;
    this.ttlConfig = config.ttl;
    this.indexConfig = config.index;
  }

  /**
   * Creates a PostgresStore instance from a connection string.
   * 
   * @param connectionString PostgreSQL connection string
   * @param options Additional configuration options
   * @returns PostgresStore instance
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
   * This method must be called before using the store.
   */
  async setup(): Promise<void> {
    if (this.isSetup) {
      return;
    }

    const client = await this.pool.connect();
    try {
      // Create schema if it doesn't exist
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

      // Enable pgvector extension if vector search is configured
      if (this.indexConfig) {
        try {
          await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
        } catch (error) {
          console.warn("pgvector extension not available. Vector search will be disabled.", error);
          this.indexConfig = undefined;
        }
      }

      // Create the main store table with TTL support
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.store (
          namespace_path TEXT NOT NULL,
          key TEXT NOT NULL,
          value JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ,
          PRIMARY KEY (namespace_path, key)
        )
      `);

      // Create vector table if vector search is enabled
      if (this.indexConfig) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.store_vectors (
            namespace_path TEXT NOT NULL,
            key TEXT NOT NULL,
            field_path TEXT NOT NULL,
            text_content TEXT NOT NULL,
            embedding vector(${this.indexConfig.dims}) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (namespace_path, key, field_path),
            FOREIGN KEY (namespace_path, key) REFERENCES ${this.schema}.store(namespace_path, key) ON DELETE CASCADE
          )
        `);

        // Create vector indexes based on configuration
        await this.createVectorIndexes(client);
      }

      // Create indexes for better performance
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_store_namespace_path 
        ON ${this.schema}.store USING btree (namespace_path)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_store_value_gin 
        ON ${this.schema}.store USING gin (value)
      `);

      // Create TTL index for efficient expiration queries
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_store_expires_at 
        ON ${this.schema}.store USING btree (expires_at) 
        WHERE expires_at IS NOT NULL
      `);

      // Create updated_at trigger
      await client.query(`
        CREATE OR REPLACE FUNCTION ${this.schema}.update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql'
      `);

      await client.query(`
        DROP TRIGGER IF EXISTS update_store_updated_at ON ${this.schema}.store
      `);

      await client.query(`
        CREATE TRIGGER update_store_updated_at
        BEFORE UPDATE ON ${this.schema}.store
        FOR EACH ROW EXECUTE FUNCTION ${this.schema}.update_updated_at_column()
      `);

      this.isSetup = true;

      // Start TTL sweeper if configured
      if (this.ttlConfig?.sweepIntervalMinutes) {
        this.startTtlSweeper();
      }
    } finally {
      client.release();
    }
  }

  /**
   * Create vector indexes based on the index configuration.
   */
  private async createVectorIndexes(client: pg.PoolClient): Promise<void> {
    if (!this.indexConfig) {
      return;
    }

    const indexType = this.indexConfig.indexType || 'hnsw';
    const distanceMetric = this.indexConfig.distanceMetric || 'cosine';
    const createAllMetrics = this.indexConfig.createAllMetricIndexes || false;

    // Determine which distance metrics to create indexes for
    const metricsToIndex: DistanceMetric[] = createAllMetrics 
      ? ['cosine', 'l2', 'inner_product']
      : [distanceMetric];

    for (const metric of metricsToIndex) {
      await this.createVectorIndex(client, indexType, metric);
    }

    // Set HNSW search parameters if using HNSW
    if (indexType === 'hnsw' && this.indexConfig.hnsw?.ef) {
      try {
        await client.query(`SET hnsw.ef_search = ${this.indexConfig.hnsw.ef}`);
      } catch (error) {
        console.warn(`Failed to set HNSW ef_search parameter: ${error}`);
      }
    }

    // Set IVFFlat search parameters if using IVFFlat
    if (indexType === 'ivfflat' && this.indexConfig.ivfflat?.probes) {
      try {
        await client.query(`SET ivfflat.probes = ${this.indexConfig.ivfflat.probes}`);
      } catch (error) {
        console.warn(`Failed to set IVFFlat probes parameter: ${error}`);
      }
    }
  }

  /**
   * Create a single vector index for a specific distance metric.
   */
  private async createVectorIndex(
    client: pg.PoolClient, 
    indexType: VectorIndexType, 
    metric: DistanceMetric
  ): Promise<void> {
    if (!this.indexConfig) {
      return;
    }

    let metricSuffix: string;
    if (metric === 'cosine') {
      metricSuffix = 'cosine';
    } else if (metric === 'l2') {
      metricSuffix = 'l2';
    } else {
      metricSuffix = 'ip';
    }
    const indexName = `idx_store_vectors_embedding_${metricSuffix}_${indexType}`;
    
    let operatorClass: string;
    switch (metric) {
      case 'cosine':
        operatorClass = 'vector_cosine_ops';
        break;
      case 'l2':
        operatorClass = 'vector_l2_ops';
        break;
      case 'inner_product':
        operatorClass = 'vector_ip_ops';
        break;
      default:
        throw new Error(`Unsupported distance metric: ${metric}`);
    }

    if (indexType === 'hnsw') {
      const m = this.indexConfig.hnsw?.m || 16;
      const efConstruction = this.indexConfig.hnsw?.efConstruction || 200;
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${this.schema}.store_vectors USING hnsw (embedding ${operatorClass})
        WITH (m = ${m}, ef_construction = ${efConstruction})
      `);
    } else if (indexType === 'ivfflat') {
      const lists = this.indexConfig.ivfflat?.lists || 100;
      
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${indexName}
        ON ${this.schema}.store_vectors USING ivfflat (embedding ${operatorClass})
        WITH (lists = ${lists})
      `);
    } else {
      throw new Error(`Unsupported index type: ${indexType}`);
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

    const client = await this.pool.connect();
    try {
      const results: any[] = [];

      for (const operation of operations) {
        if ("namespacePrefix" in operation) {
          // SearchOperation
          results.push(await this.executeSearch(client, operation));
        } else if ("key" in operation && !("value" in operation)) {
          // GetOperation
          results.push(await this.executeGet(client, operation));
        } else if ("value" in operation) {
          // PutOperation
          results.push(await this.executePut(client, operation));
        } else if ("matchConditions" in operation) {
          // ListNamespacesOperation
          results.push(await this.executeListNamespaces(client, operation));
        } else {
          throw new Error(`Unsupported operation type: ${JSON.stringify(operation)}`);
        }
      }

      return results as OperationResults<Op>;
    } finally {
      client.release();
    }
  }

  /**
   * Build advanced filter conditions for search queries.
   */
  private buildFilterConditions(
    filter: Record<string, any>,
    params: any[],
    paramIndex: number
  ): { conditions: string[]; newParamIndex: number } {
    const conditions: string[] = [];
    let currentParamIndex = paramIndex;

    for (const [key, value] of Object.entries(filter)) {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        // Check if it's a filter operator object
        const operators = Object.keys(value);
        const isOperatorObject = operators.some(op => op.startsWith('$'));
        
        if (isOperatorObject) {
          // Handle advanced operators
          for (const [operator, operatorValue] of Object.entries(value)) {
            switch (operator) {
              case '$eq':
                conditions.push(`value ->> $${currentParamIndex} = $${currentParamIndex + 1}`);
                params.push(key, String(operatorValue));
                currentParamIndex += 2;
                break;
              case '$ne':
                conditions.push(`value ->> $${currentParamIndex} != $${currentParamIndex + 1}`);
                params.push(key, String(operatorValue));
                currentParamIndex += 2;
                break;
              case '$gt':
                conditions.push(`(value ->> $${currentParamIndex})::numeric > $${currentParamIndex + 1}`);
                params.push(key, operatorValue);
                currentParamIndex += 2;
                break;
              case '$gte':
                conditions.push(`(value ->> $${currentParamIndex})::numeric >= $${currentParamIndex + 1}`);
                params.push(key, operatorValue);
                currentParamIndex += 2;
                break;
              case '$lt':
                conditions.push(`(value ->> $${currentParamIndex})::numeric < $${currentParamIndex + 1}`);
                params.push(key, operatorValue);
                currentParamIndex += 2;
                break;
              case '$lte':
                conditions.push(`(value ->> $${currentParamIndex})::numeric <= $${currentParamIndex + 1}`);
                params.push(key, operatorValue);
                currentParamIndex += 2;
                break;
              case '$in':
                if (Array.isArray(operatorValue) && operatorValue.length > 0) {
                  const placeholders: string[] = [];
                  for (let i = 0; i < operatorValue.length; i += 1) {
                    placeholders.push(`$${currentParamIndex + 1 + i}`);
                  }
                  conditions.push(`value ->> $${currentParamIndex} = ANY(ARRAY[${placeholders.join(',')}])`);
                  params.push(key, ...operatorValue.map(String));
                  currentParamIndex += 1 + operatorValue.length;
                }
                break;
              case '$nin':
                if (Array.isArray(operatorValue) && operatorValue.length > 0) {
                  const placeholders: string[] = [];
                  for (let i = 0; i < operatorValue.length; i += 1) {
                    placeholders.push(`$${currentParamIndex + 1 + i}`);
                  }
                  conditions.push(`value ->> $${currentParamIndex} != ALL(ARRAY[${placeholders.join(',')}])`);
                  params.push(key, ...operatorValue.map(String));
                  currentParamIndex += 1 + operatorValue.length;
                }
                break;
              case '$exists':
                if (operatorValue) {
                  conditions.push(`value ? $${currentParamIndex}`);
                } else {
                  conditions.push(`NOT (value ? $${currentParamIndex})`);
                }
                params.push(key);
                currentParamIndex += 1;
                break;
              default:
                // Unknown operator, ignore
                break;
            }
          }
        } else {
          // Handle nested object queries
          conditions.push(`value @> $${currentParamIndex}::jsonb`);
          params.push(JSON.stringify({ [key]: value }));
          currentParamIndex += 1;
        }
      } else {
        // Handle simple value queries
        conditions.push(`value ->> $${currentParamIndex} = $${currentParamIndex + 1}`);
        params.push(key, String(value));
        currentParamIndex += 2;
      }
    }

    return { conditions, newParamIndex: currentParamIndex };
  }

  private async executeGet(
    client: pg.PoolClient,
    operation: GetOperation
  ): Promise<Item | null> {
    validateNamespace(operation.namespace);
    
    const namespacePath = operation.namespace.join(":");
    
    const result = await client.query(`
      SELECT namespace_path, key, value, created_at, updated_at
      FROM ${this.schema}.store
      WHERE namespace_path = $1 AND key = $2
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `, [namespacePath, operation.key]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    
    // Refresh TTL if configured
    if (this.ttlConfig?.refreshOnRead) {
      await this.refreshTtl(client, namespacePath, operation.key);
    }

    return {
      namespace: row.namespace_path.split(":"),
      key: row.key,
      value: row.value,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async executePut(
    client: pg.PoolClient,
    operation: PutOperation
  ): Promise<void> {
    validateNamespace(operation.namespace);
    
    const namespacePath = operation.namespace.join(":");
    const { key, value } = operation;
    
    if (value === null) {
      // Delete operation - also delete vectors
      await client.query(`
        DELETE FROM ${this.schema}.store
        WHERE namespace_path = $1 AND key = $2
      `, [namespacePath, key]);
    } else {
      // Insert or update operation
      const expiresAt = this.calculateExpiresAt();

      await client.query(`
        INSERT INTO ${this.schema}.store (namespace_path, key, value, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (namespace_path, key)
        DO UPDATE SET 
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = CURRENT_TIMESTAMP
      `, [namespacePath, key, value, expiresAt]);

      // Handle vector indexing if configured
      if (this.indexConfig) {
        await this.indexItemVectors(client, namespacePath, key, value);
      }
    }
  }

  /**
   * Index vectors for an item based on configured fields.
   */
  private async indexItemVectors(
    client: pg.PoolClient,
    namespacePath: string,
    key: string,
    value: Record<string, any>
  ): Promise<void> {
    if (!this.indexConfig) {
      return;
    }

    // Delete existing vectors for this item
    await client.query(`
      DELETE FROM ${this.schema}.store_vectors 
      WHERE namespace_path = $1 AND key = $2
    `, [namespacePath, key]);

    const fields = this.indexConfig.fields || ["$"];
    const textsToEmbed: { fieldPath: string; text: string }[] = [];

    // Extract text from configured fields
    for (const fieldPath of fields) {
      const extractedTexts = this.extractTextAtPath(value, fieldPath);
      for (let i = 0; i < extractedTexts.length; i += 1) {
        const text = extractedTexts[i];
        if (text && text.trim()) {
          const actualFieldPath = extractedTexts.length > 1 ? `${fieldPath}[${i}]` : fieldPath;
          textsToEmbed.push({ fieldPath: actualFieldPath, text: text.trim() });
        }
      }
    }

    if (textsToEmbed.length === 0) {
      return;
    }

    // Generate embeddings
    const texts = textsToEmbed.map(item => item.text);
    const embeddings = await this.generateEmbeddings(texts);

    // Insert vectors
    for (let i = 0; i < textsToEmbed.length; i += 1) {
      const { fieldPath, text } = textsToEmbed[i];
      const embedding = embeddings[i];
      
      if (embedding && embedding.length === this.indexConfig.dims) {
        await client.query(`
          INSERT INTO ${this.schema}.store_vectors 
          (namespace_path, key, field_path, text_content, embedding)
          VALUES ($1, $2, $3, $4, $5)
        `, [namespacePath, key, fieldPath, text, `[${embedding.join(',')}]`]);
      }
    }
  }

  private async executeSearch(
    client: pg.PoolClient,
    operation: SearchOperation
  ): Promise<Item[]> {
    validateNamespace(operation.namespacePrefix);
    
    const namespacePath = operation.namespacePrefix.join(":");
    const { filter, limit = 10, offset = 0, query } = operation;

    // If vector search is configured and query is provided, use vector similarity search
    if (this.indexConfig && query) {
      return this.executeVectorSearch(client, operation);
    }

    let sqlQuery = `
      SELECT namespace_path, key, value, created_at, updated_at
      FROM ${this.schema}.store
      WHERE namespace_path LIKE $1
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `;
    
    const params: any[] = [`${namespacePath}%`];
    let paramIndex = 2;

    // Add filter conditions using advanced filtering
    if (filter && Object.keys(filter).length > 0) {
      const { conditions, newParamIndex } = this.buildFilterConditions(
        filter,
        params,
        paramIndex
      );
      if (conditions.length > 0) {
        sqlQuery += ` AND (${conditions.join(" AND ")})`;
        paramIndex = newParamIndex;
      }
    }

    // Add text search if query is provided but no vector search
    if (query && !this.indexConfig) {
      sqlQuery += ` AND to_tsvector('english', value::text) @@ plainto_tsquery('english', $${paramIndex})`;
      params.push(query);
      paramIndex += 1;
    }

    sqlQuery += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await client.query(sqlQuery, params);
    
    return result.rows.map((row) => ({
      namespace: row.namespace_path.split(":"),
      key: row.key,
      value: row.value,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Execute vector similarity search.
   */
  private async executeVectorSearch(
    client: pg.PoolClient,
    operation: SearchOperation
  ): Promise<Item[]> {
    if (!this.indexConfig || !operation.query) {
      return [];
    }

    validateNamespace(operation.namespacePrefix);
    
    const namespacePath = operation.namespacePrefix.join(":");
    const { filter, limit = 10, offset = 0, query } = operation;

    // Generate query embedding
    const queryEmbedding = await this.generateQueryEmbedding(query);
    
    if (queryEmbedding.length !== this.indexConfig.dims) {
      throw new Error(`Query embedding dimension mismatch: expected ${this.indexConfig.dims}, got ${queryEmbedding.length}`);
    }

    let sqlQuery = `
      SELECT DISTINCT 
        s.namespace_path, 
        s.key, 
        s.value, 
        s.created_at, 
        s.updated_at,
        MIN(v.embedding <=> $2) as similarity_score
      FROM ${this.schema}.store s
      JOIN ${this.schema}.store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
      WHERE s.namespace_path LIKE $1
        AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
    `;
    
    const params: any[] = [`${namespacePath}%`, `[${queryEmbedding.join(',')}]`];
    let paramIndex = 3;

    // Add filter conditions
    if (filter && Object.keys(filter).length > 0) {
      const { conditions, newParamIndex } = this.buildFilterConditions(
        filter,
        params,
        paramIndex
      );
      if (conditions.length > 0) {
        // Adjust conditions to use 's.' prefix for store table columns
        const adjustedConditions = conditions.map(condition => 
          condition.replace(/value ->/g, 's.value ->')
        );
        sqlQuery += ` AND (${adjustedConditions.join(" AND ")})`;
        paramIndex = newParamIndex;
      }
    }

    sqlQuery += ` 
      GROUP BY s.namespace_path, s.key, s.value, s.created_at, s.updated_at
      ORDER BY similarity_score ASC 
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);

    const result = await client.query(sqlQuery, params);
    
    return result.rows.map((row) => ({
      namespace: row.namespace_path.split(":"),
      key: row.key,
      value: row.value,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      score: 1 - parseFloat(row.similarity_score), // Convert distance to similarity
    }));
  }

  private async executeListNamespaces(
    client: pg.PoolClient,
    operation: ListNamespacesOperation
  ): Promise<string[][]> {
    const { matchConditions, maxDepth, limit = 100, offset = 0 } = operation;

    let sqlQuery = `
      SELECT DISTINCT namespace_path
      FROM ${this.schema}.store
    `;
    
    const params: any[] = [];
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

    sqlQuery += ` ORDER BY namespace_path LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
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
      // Note: This is synchronous, but setup is async
      // In practice, users should call setup() explicitly
      this.setup().catch((error) => {
        console.error("Failed to setup PostgresStore:", error);
      });
    }
  }

  /**
   * Stop the store and close all database connections.
   */
  stop(): void {
    if (this.isClosed) {
      return; // Already closed
    }
    
    this.stopTtlSweeper();
    this.pool.end().catch((error) => {
      console.error("Error closing PostgreSQL pool:", error);
    });
    this.isClosed = true;
  }

  /**
   * Close all database connections.
   * Alias for stop() method.
   */
  async end(): Promise<void> {
    if (this.isClosed) {
      return; // Already closed
    }
    
    this.stopTtlSweeper();
    await this.pool.end();
    this.isClosed = true;
  }

  /**
   * Start the TTL sweeper process.
   */
  private startTtlSweeper(): void {
    if (this.ttlSweepInterval) {
      return; // Already running
    }

    const intervalMs = (this.ttlConfig?.sweepIntervalMinutes || 60) * 60 * 1000;
    this.ttlSweepInterval = setInterval(() => {
      this.sweepExpiredItems().catch((error) => {
        console.error("Error during TTL sweep:", error);
      });
    }, intervalMs);
  }

  /**
   * Stop the TTL sweeper process.
   */
  private stopTtlSweeper(): void {
    if (this.ttlSweepInterval) {
      clearInterval(this.ttlSweepInterval);
      this.ttlSweepInterval = undefined;
    }
  }

  /**
   * Manually sweep expired items from the store.
   */
  async sweepExpiredItems(): Promise<number> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        DELETE FROM ${this.schema}.store 
        WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP
      `);
      return result.rowCount || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Calculate expiration timestamp based on TTL.
   */
  private calculateExpiresAt(ttl?: number): Date | null {
    const effectiveTtl = ttl ?? this.ttlConfig?.defaultTtl;
    if (!effectiveTtl) {
      return null;
    }
    return new Date(Date.now() + effectiveTtl * 60 * 1000);
  }

  /**
   * Refresh TTL for an item.
   */
  private async refreshTtl(
    client: pg.PoolClient,
    namespacePath: string,
    key: string
  ): Promise<void> {
    if (!this.ttlConfig?.refreshOnRead) {
      return;
    }

    const expiresAt = this.calculateExpiresAt();
    if (expiresAt) {
      await client.query(`
        UPDATE ${this.schema}.store 
        SET expires_at = $3, updated_at = CURRENT_TIMESTAMP
        WHERE namespace_path = $1 AND key = $2
      `, [namespacePath, key, expiresAt]);
    }
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

    const client = await this.pool.connect();
    try {
      validateNamespace(namespacePrefix);
      
      const namespacePath = namespacePrefix.join(":");
      const { filter, limit = 10, offset = 0, query, refreshTtl } = options;

      let sqlQuery = `
        SELECT 
          namespace_path, 
          key, 
          value, 
          created_at, 
          updated_at,
          CASE 
            WHEN $2::text IS NOT NULL THEN 
              ts_rank(to_tsvector('english', value::text), plainto_tsquery('english', $2::text))
            ELSE 0
          END as score
        FROM ${this.schema}.store
        WHERE namespace_path LIKE $1
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      `;
      
      const params: any[] = [`${namespacePath}%`, query || null];
      let paramIndex = 3;

      // Add filter conditions using advanced filtering
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } = this.buildFilterConditions(filter, params, paramIndex);
        if (conditions.length > 0) {
          sqlQuery += ` AND (${conditions.join(" AND ")})`;
          paramIndex = newParamIndex;
        }
      }

      // Add full-text search if query is provided
      if (query) {
        sqlQuery += ` AND (
          to_tsvector('english', value::text) @@ plainto_tsquery('english', $2::text)
          OR value::text ILIKE $${paramIndex}
        )`;
        params.push(`%${query}%`);
        paramIndex += 1;
      }

      // Add ordering by score if query provided, otherwise by updated_at
      if (query) {
        sqlQuery += ` ORDER BY score DESC, updated_at DESC`;
      } else {
        sqlQuery += ` ORDER BY updated_at DESC`;
      }
      
      sqlQuery += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await client.query(sqlQuery, params);
      
      const items: SearchItem[] = result.rows.map((row) => ({
        namespace: row.namespace_path.split(":"),
        key: row.key,
        value: row.value,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        score: row.score || undefined,
      }));

      // Refresh TTL for returned items if requested
      if (refreshTtl || this.ttlConfig?.refreshOnRead) {
        for (const item of items) {
          await this.refreshTtl(client, item.namespace.join(":"), item.key);
        }
      }

      return items;
    } finally {
      client.release();
    }
  }

  /**
   * Put an item with advanced options including TTL.
   */
  async putAdvanced(
    namespace: string[],
    key: string,
    value: Record<string, any> | null,
    options: PutOptions = {}
  ): Promise<void> {
    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    const client = await this.pool.connect();
    try {
      validateNamespace(namespace);
      
      const namespacePath = namespace.join(":");
      
      if (value === null) {
        // Delete operation
        await client.query(`
          DELETE FROM ${this.schema}.store
          WHERE namespace_path = $1 AND key = $2
        `, [namespacePath, key]);
      } else {
        // Insert or update operation
        const expiresAt = this.calculateExpiresAt(options.ttl);

        await client.query(`
          INSERT INTO ${this.schema}.store (namespace_path, key, value, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (namespace_path, key)
          DO UPDATE SET 
            value = EXCLUDED.value,
            expires_at = EXCLUDED.expires_at,
            updated_at = CURRENT_TIMESTAMP
        `, [namespacePath, key, JSON.stringify(value), expiresAt]);
      }
    } finally {
      client.release();
    }
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

    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          COUNT(*) as total_items,
          COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 1 END) as expired_items,
          COUNT(DISTINCT namespace_path) as namespace_count,
          MIN(created_at) as oldest_item,
          MAX(created_at) as newest_item
        FROM ${this.schema}.store
      `);

      const row = result.rows[0];
      return {
        totalItems: parseInt(row.total_items, 10),
        expiredItems: parseInt(row.expired_items, 10),
        namespaceCount: parseInt(row.namespace_count, 10),
        oldestItem: row.oldest_item,
        newestItem: row.newest_item,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Extract text from an object using JSON path expressions.
   */
  private extractTextAtPath(obj: any, path: string): string[] {
    if (path === "$") {
      return [JSON.stringify(obj)];
    }

    const parts = path.split('.');
    let current = obj;
    const results: string[] = [];

    try {
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        
        if (part.includes('[')) {
          // Handle array notation
          const [field, arrayPart] = part.split('[');
          const arrayIndex = arrayPart.replace(']', '');
          
          if (field) {
            current = current[field];
          }
          
          if (arrayIndex === '*') {
            // Extract from all array elements
            if (Array.isArray(current)) {
              const remainingPath = parts.slice(i + 1).join('.');
              
              if (remainingPath) {
                // Continue processing the remaining path for each array element
                for (const item of current) {
                  if (item !== null && item !== undefined) {
                    const subResults = this.extractTextAtPath(item, remainingPath);
                    results.push(...subResults);
                  }
                }
              } else {
                // No remaining path, extract values directly
                for (const item of current) {
                  if (typeof item === 'string') {
                    results.push(item);
                  } else if (typeof item === 'object' && item !== null) {
                    results.push(JSON.stringify(item));
                  } else if (item !== null && item !== undefined) {
                    results.push(String(item));
                  }
                }
              }
            }
            return results;
          } else if (arrayIndex === '-1') {
            // Last element
            if (Array.isArray(current) && current.length > 0) {
              current = current[current.length - 1];
            }
          } else {
            // Specific index
            const index = parseInt(arrayIndex, 10);
            if (Array.isArray(current) && index >= 0 && index < current.length) {
              current = current[index];
            }
          }
        } else {
          current = current?.[part];
        }
        
        if (current === undefined || current === null) {
          return [];
        }
      }

      if (typeof current === 'string') {
        results.push(current);
      } else if (typeof current === 'object' && current !== null) {
        results.push(JSON.stringify(current));
      } else {
        results.push(String(current));
      }
    } catch (error) {
      // Path extraction failed, return empty array
      return [];
    }

    return results;
  }

  /**
   * Generate embeddings for text content using the configured embedding function.
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.indexConfig) {
      throw new Error("Vector search not configured");
    }

    const { embed } = this.indexConfig;

    if (typeof embed === 'string') {
      throw new Error(`Provider string embeddings not yet implemented: ${embed}`);
    }

    if (typeof embed === 'function') {
      return await embed(texts);
    }

    // LangChain Embeddings interface
    if (embed && typeof embed === 'object' && 'embedDocuments' in embed) {
      return await (embed as Embeddings).embedDocuments(texts);
    }

    throw new Error("Invalid embedding configuration");
  }

  /**
   * Generate embedding for a single query text.
   */
  private async generateQueryEmbedding(text: string): Promise<number[]> {
    if (!this.indexConfig) {
      throw new Error("Vector search not configured");
    }

    const { embed } = this.indexConfig;

    if (typeof embed === 'string') {
      throw new Error(`Provider string embeddings not yet implemented: ${embed}`);
    }

    if (typeof embed === 'function') {
      const embeddings = await embed([text]);
      return embeddings[0] || [];
    }

    // LangChain Embeddings interface
    if (embed && typeof embed === 'object' && 'embedQuery' in embed) {
      return await (embed as Embeddings).embedQuery(text);
    }

    if (embed && typeof embed === 'object' && 'embedDocuments' in embed) {
      const embeddings = await (embed as Embeddings).embedDocuments([text]);
      return embeddings[0] || [];
    }

    throw new Error("Invalid embedding configuration");
  }

  /**
   * Enhanced vector similarity search with advanced options.
   */
  async vectorSearch(
    namespacePrefix: string[],
    query: string,
    options: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
      similarityThreshold?: number;
      distanceMetric?: 'cosine' | 'l2' | 'inner_product';
    } = {}
  ): Promise<SearchItem[]> {
    if (!this.indexConfig) {
      throw new Error("Vector search not configured. Please provide an IndexConfig when creating the store.");
    }

    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    const client = await this.pool.connect();
    try {
      validateNamespace(namespacePrefix);
      
      const namespacePath = namespacePrefix.join(":");
      const { 
        filter, 
        limit = 10, 
        offset = 0, 
        similarityThreshold = 0.0,
        distanceMetric = 'cosine'
      } = options;

      // Generate query embedding
      const queryEmbedding = await this.generateQueryEmbedding(query);
      
      if (queryEmbedding.length !== this.indexConfig.dims) {
        throw new Error(`Query embedding dimension mismatch: expected ${this.indexConfig.dims}, got ${queryEmbedding.length}`);
      }

      // Choose distance operator based on metric
      let distanceOp: string;
      let scoreTransform: string;
      switch (distanceMetric) {
        case 'l2':
          distanceOp = '<->';
          scoreTransform = '1 / (1 + MIN(v.embedding <-> $2))'; // Convert L2 distance to similarity
          break;
        case 'inner_product':
          distanceOp = '<#>';
          scoreTransform = 'MIN(v.embedding <#> $2)'; // Inner product (higher is better)
          break;
        case 'cosine':
        default:
          distanceOp = '<=>';
          scoreTransform = '1 - MIN(v.embedding <=> $2)'; // Convert cosine distance to similarity
          break;
      }

      let sqlQuery = `
        SELECT DISTINCT 
          s.namespace_path, 
          s.key, 
          s.value, 
          s.created_at, 
          s.updated_at,
          ${scoreTransform} as similarity_score
        FROM ${this.schema}.store s
        JOIN ${this.schema}.store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE s.namespace_path LIKE $1
          AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
      `;
      
      const params: any[] = [`${namespacePath}%`, `[${queryEmbedding.join(',')}]`];
      let paramIndex = 3;

      // Add similarity threshold
      if (similarityThreshold > 0) {
        if (distanceMetric === 'inner_product') {
          sqlQuery += ` AND v.embedding <#> $2 >= $${paramIndex}`;
        } else {
          sqlQuery += ` AND v.embedding ${distanceOp} $2 <= $${paramIndex}`;
        }
        params.push(distanceMetric === 'cosine' ? 1 - similarityThreshold : similarityThreshold);
        paramIndex += 1;
      }

      // Add filter conditions
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } = this.buildFilterConditions(
          filter,
          params,
          paramIndex
        );
        if (conditions.length > 0) {
          const adjustedConditions = conditions.map(condition => 
            condition.replace(/value ->/g, 's.value ->')
          );
          sqlQuery += ` AND (${adjustedConditions.join(" AND ")})`;
          paramIndex = newParamIndex;
        }
      }

      const orderDirection = distanceMetric === 'inner_product' ? 'DESC' : 'ASC';
      sqlQuery += ` 
        GROUP BY s.namespace_path, s.key, s.value, s.created_at, s.updated_at
        ORDER BY similarity_score ${orderDirection}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params.push(limit, offset);

      const result = await client.query(sqlQuery, params);
      
      return result.rows.map((row) => ({
        namespace: row.namespace_path.split(":"),
        key: row.key,
        value: row.value,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        score: parseFloat(row.similarity_score),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Hybrid search combining vector similarity and text search.
   */
  async hybridSearch(
    namespacePrefix: string[],
    query: string,
    options: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
      vectorWeight?: number; // 0.0 to 1.0, weight for vector search vs text search
      similarityThreshold?: number;
    } = {}
  ): Promise<SearchItem[]> {
    if (!this.indexConfig) {
      throw new Error("Vector search not configured. Please provide an IndexConfig when creating the store.");
    }

    if (!this.isSetup && this.ensureTables) {
      await this.setup();
    }

    const client = await this.pool.connect();
    try {
      validateNamespace(namespacePrefix);
      
      const namespacePath = namespacePrefix.join(":");
      const { 
        filter, 
        limit = 10, 
        offset = 0, 
        vectorWeight = 0.7,
        similarityThreshold = 0.0
      } = options;

      // Generate query embedding
      const queryEmbedding = await this.generateQueryEmbedding(query);
      
      if (queryEmbedding.length !== this.indexConfig.dims) {
        throw new Error(`Query embedding dimension mismatch: expected ${this.indexConfig.dims}, got ${queryEmbedding.length}`);
      }

      let sqlQuery = `
        SELECT DISTINCT 
          s.namespace_path, 
          s.key, 
          s.value, 
          s.created_at, 
          s.updated_at,
          (
            $3 * (1 - MIN(v.embedding <=> $2)) + 
            (1 - $3) * ts_rank(to_tsvector('english', s.value::text), plainto_tsquery('english', $4))
          ) as hybrid_score
        FROM ${this.schema}.store s
        JOIN ${this.schema}.store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE s.namespace_path LIKE $1
          AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
          AND (
            to_tsvector('english', s.value::text) @@ plainto_tsquery('english', $4)
            OR v.embedding <=> $2 <= $5
          )
      `;
      
      const params: any[] = [
        `${namespacePath}%`, 
        `[${queryEmbedding.join(',')}]`,
        vectorWeight,
        query,
        1 - similarityThreshold
      ];
      let paramIndex = 6;

      // Add filter conditions
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } = this.buildFilterConditions(
          filter,
          params,
          paramIndex
        );
        if (conditions.length > 0) {
          const adjustedConditions = conditions.map(condition => 
            condition.replace(/value ->/g, 's.value ->')
          );
          sqlQuery += ` AND (${adjustedConditions.join(" AND ")})`;
          paramIndex = newParamIndex;
        }
      }

      sqlQuery += ` 
        GROUP BY s.namespace_path, s.key, s.value, s.created_at, s.updated_at
        ORDER BY hybrid_score DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params.push(limit, offset);

      const result = await client.query(sqlQuery, params);
      
      return result.rows.map((row) => ({
        namespace: row.namespace_path.split(":"),
        key: row.key,
        value: row.value,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        score: parseFloat(row.hybrid_score),
      }));
    } finally {
      client.release();
    }
  }
}

export default PostgresStore;
