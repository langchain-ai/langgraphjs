import pkg, { type PoolConfig } from 'pg';
import {
  BaseStore,
  type OperationResults,
  type Item,
  type Operation,
  type ListNamespacesOperation,
  type PutOperation,
  type SearchOperation,
  type GetOperation,
  type IndexConfig,
  type SearchItem,
} from './base.js';
import { tokenizePath, getTextAtPath } from "./utils.js";

const { Pool } = pkg;

/**
 * Configuration for vector index in PostgreSQL store.
 */
export interface ANNIndexConfig {
  /**
   * Type of index to use: 'hnsw' for Hierarchical Navigable Small World, or 'ivfflat' for Inverted File Flat.
   */
  kind: "hnsw" | "ivfflat" | "flat";

  /**
   * Type of vector storage to use.
   * - 'vector': Regular vectors (default)
   * - 'halfvec': Half-precision vectors for reduced memory usage
   */
  vectorType?: "vector" | "halfvec";

  /**
   * Maximum number of connections per layer (HNSW only).
   * @default 16
   */
  m?: number;

  /**
   * Size of dynamic candidate list for index construction (HNSW only).
   * @default 64
   */
  efConstruction?: number;

  /**
   * Number of inverted lists (clusters) for IVF index (IVFFlat only).
   */
  nlist?: number;
}

/**
 * Configuration for HNSW (Hierarchical Navigable Small World) index.
 */
export interface HNSWConfig extends ANNIndexConfig {
  kind: "hnsw";
}

/**
 * Configuration for IVF Flat index.
 */
export interface IVFFlatConfig extends ANNIndexConfig {
  kind: "ivfflat";
}

/**
 * Configuration for vector embeddings in PostgreSQL store with pgvector-specific options.
 */
export interface PostgresIndexConfig extends IndexConfig {
  /**
   * Specific configuration for the chosen index type (HNSW or IVF Flat)
   */
  annIndexConfig?: ANNIndexConfig;

  /**
   * Distance metric to use for vector similarity search
   */
  distanceType?: "l2" | "inner_product" | "cosine";
}

/**
 * Row type for database results
 */
interface Row {
  key: string;
  value: Record<string, unknown>;
  prefix: string;
  created_at: Date;
  updated_at: Date;
  score?: number;
}

/**
 * PostgreSQL-backed store with optional vector search using pgvector.
 * 
 * --- Basic setup and usage ---
 * const store = new PostgresStore({
 *   connectionString: "postgresql://user:pass@localhost:5432/dbname"
 * });
 * await store.setup(); // Run migrations once
 * 
 * --- Store and retrieve data ---
 * await store.put(["users", "123"], "prefs", { theme: "dark" });
 * const item = await store.get(["users", "123"], "prefs");
 * 
 * --- Vector search with embeddings ---
 * const store = new PostgresStore({
 *   connectionString: "postgresql://user:pass@localhost:5432/dbname",
 *   index: {
 *     dims: 1536,
 *     embeddings: new OpenAIEmbeddings({ modelName: "text-embedding-3-small" }),
 *     fields: ["text"] // specify which fields to embed
 *   }
 * });
 * 
 * --- Store documents ---
 * await store.put(["docs"], "doc1", { text: "Python tutorial" });
 * await store.put(["docs"], "doc2", { text: "TypeScript guide" });
 * 
 * --- Search by similarity ---
 * const results = await store.search(["docs"], { query: "programming guides" });
 */
export class PostgresStore extends BaseStore {
  private pool: InstanceType<typeof Pool>;

  private indexConfig?: PostgresIndexConfig & {
    __tokenizedFields?: Array<[string, string[]]>;
  };

  constructor(
    config: PoolConfig & {
      index?: PostgresIndexConfig;
    }
  ) {
    super();
    const { index, ...poolConfig } = config;
    this.pool = new Pool(poolConfig);

    if (index) {
      this.indexConfig = {
        ...index,
        __tokenizedFields: (index.fields ?? ["$"]).map((p) => [
          p,
          p === "$" ? [p] : tokenizePath(p),
        ]),
      };
    }
  }

  /**
   * Set up the store database.
   * Creates necessary tables and extensions if they don't exist.
   */
  async setup(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Create migrations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS store_migrations (
          v INTEGER PRIMARY KEY
        )
      `);

      // Get current version
      const { rows: [row] } = await client.query(
        "SELECT v FROM store_migrations ORDER BY v DESC LIMIT 1"
      );
      const version = row ? row.v : -1;

      // Base migrations
      const migrations = [
        `
        CREATE TABLE IF NOT EXISTS store (
          prefix text NOT NULL,
          key text NOT NULL,
          value jsonb NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (prefix, key)
        )
        `,
        `
        CREATE INDEX CONCURRENTLY IF NOT EXISTS store_prefix_idx 
        ON store USING btree (prefix text_pattern_ops)
        `,
      ];

      // Run pending migrations
      for (let v = version + 1; v < migrations.length; v += 1) {
        await client.query(migrations[v]);
        await client.query("INSERT INTO store_migrations (v) VALUES ($1)", [v]);
      }

      // Vector search setup if configured
      if (this.indexConfig) {
        // Create vector migrations table
        await client.query(`
          CREATE TABLE IF NOT EXISTS vector_migrations (
            v INTEGER PRIMARY KEY
          )
        `);

        const { rows: [vrow] } = await client.query(
          "SELECT v FROM vector_migrations ORDER BY v DESC LIMIT 1"
        );
        const vversion = vrow ? vrow.v : -1;

        // Vector migrations
        const vectorMigrations = [
          "CREATE EXTENSION IF NOT EXISTS vector",
          `
          CREATE TABLE IF NOT EXISTS store_vectors (
            prefix text NOT NULL,
            key text NOT NULL,
            field_name text NOT NULL,
            embedding vector(${this.indexConfig.dims}),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (prefix, key, field_name),
            FOREIGN KEY (prefix, key) REFERENCES store(prefix, key) ON DELETE CASCADE
          )
          `,
        ];

        // Add index if configured
        const indexConfig = this.indexConfig.annIndexConfig;
        if (indexConfig && indexConfig.kind !== "flat") {
          const indexType = indexConfig.kind === "hnsw" ? "hnsw" : "ivfflat";
          const vectorType = indexConfig.vectorType || "vector";
          const distanceType = this.indexConfig.distanceType || "cosine";
          
          const opClass = this.getVectorOpClass(vectorType, distanceType);

          let indexParams = "";
          if (indexConfig.kind === "hnsw") {
            indexParams = `WITH (m=${indexConfig.m ?? 16}, ef_construction=${
              indexConfig.efConstruction ?? 64
            })`;
          } else if (indexConfig.kind === "ivfflat") {
            indexParams = `WITH (lists=${indexConfig.nlist ?? 100})`;
          }

          vectorMigrations.push(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS store_vectors_embedding_idx 
            ON store_vectors USING ${indexType} (embedding ${opClass}) ${indexParams}
          `);
        }

        // Run pending vector migrations
        for (let v = vversion + 1; v < vectorMigrations.length; v += 1) {
          await client.query(vectorMigrations[v]);
          await client.query("INSERT INTO vector_migrations (v) VALUES ($1)", [v]);
        }
      }
    } finally {
      client.release();
    }
  }

  private getVectorOpClass(vectorType: string, distanceType: string): string {
    const prefix = vectorType === "vector" ? "vector" : "halfvec";
    let suffix = "cosine_ops";

    if (distanceType === "l2") {
      suffix = "l2_ops";
    } else if (distanceType === "inner_product") {
      suffix = "ip_ops";
    }

    return `${prefix}_${suffix}`;
  }

  private namespaceToText(ns: string[], handleWildcards = false): string {
    const namespace = handleWildcards 
      ? ns.map(val => val === "*" ? "%" : val)
      : ns;
    return namespace.join(".");
  }

  private createSearchResult(row: Row): SearchItem {
    return {
      key: row.key,
      namespace: row.prefix.split("."),
      value: row.value as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.score !== undefined && { score: row.score }),
    };
  }

  private createItem(row: Row, namespace: string[]): Item {
    return {
      key: row.key,
      namespace,
      value: row.value as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private updateResults<T>(results: T[], index: number, value: T): void {
    Object.defineProperty(results, index, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }

  private async batchGetOps(
    getOps: Array<[number, GetOperation]>,
    results: (Item | null)[]
  ): Promise<void> {
    // Group by namespace for efficiency
    const namespaceGroups = new Map<string, Array<[number, string]>>();
    for (const [idx, op] of getOps) {
      const ns = this.namespaceToText(op.namespace);
      if (!namespaceGroups.has(ns)) {
        namespaceGroups.set(ns, []);
      }
      namespaceGroups.get(ns)!.push([idx, op.key]);
    }

    // Execute queries
    const client = await this.pool.connect();
    try {
      for (const [namespace, items] of namespaceGroups) {
        const keys = items.map(([_, key]) => key);
        const { rows } = await client.query<Row>(
          `
          SELECT key, value, created_at, updated_at
          FROM store
          WHERE prefix = $1 AND key = ANY($2)
          `,
          [namespace, keys]
        );

        // Map results back to original indices
        const keyToRow: Map<string, Row> = new Map(rows.map(row => [row.key, row]));
        for (const [idx, key] of items) {
          const row = keyToRow.get(key);
          if (row) {
            this.updateResults(results, idx, this.createItem(row, namespace.split(".")));
          } else {
            this.updateResults(results, idx, null);
          }
        }
      }
    } finally {
      client.release();
    }
  }

  private async batchPutOps(putOps: Array<[number, PutOperation]>): Promise<void> {
    // Deduplicate operations (last write wins)
    const dedupedOps = new Map<string, PutOperation>();
    for (const [_, op] of putOps) {
      const key = `${this.namespaceToText(op.namespace)}:${op.key}`;
      dedupedOps.set(key, op);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Handle deletes
      const deletes = Array.from(dedupedOps.values()).filter(op => op.value === null);
      if (deletes.length > 0) {
        const namespaceGroups = new Map<string, string[]>();
        for (const op of deletes) {
          const ns = this.namespaceToText(op.namespace);
          if (!namespaceGroups.has(ns)) {
            namespaceGroups.set(ns, []);
          }
          namespaceGroups.get(ns)!.push(op.key);
        }

        for (const [namespace, keys] of namespaceGroups) {
          await client.query(
            `DELETE FROM store WHERE prefix = $1 AND key = ANY($2)`,
            [namespace, keys]
          );
        }
      }

      // Handle inserts/updates
      const upserts = Array.from(dedupedOps.values()).filter(op => op.value !== null);
      if (upserts.length > 0) {
        // Main store upserts
        const values: string[] = [];
        const params: string[] = [];
        let paramIndex = 1;

        for (const op of upserts) {
          values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
          params.push(
            this.namespaceToText(op.namespace),
            op.key,
            JSON.stringify(op.value)
          );
          paramIndex += 3;
        }

        await client.query(
          `
          INSERT INTO store (prefix, key, value, created_at, updated_at)
          VALUES ${values.join(",")}
          ON CONFLICT (prefix, key) DO UPDATE
          SET value = EXCLUDED.value,
              updated_at = CURRENT_TIMESTAMP
          `,
          params
        );

        // Handle vector embeddings if configured
        if (this.indexConfig?.embeddings) {
          const toEmbed: Record<string, Array<[string[], string, string]>> = {};
          
          for (const op of upserts) {
            if (op.index === false) continue;

            const paths = op.index === undefined
              ? this.indexConfig.__tokenizedFields ?? []
              : op.index.map(ix => [ix, tokenizePath(ix)] as [string, string[]]);

            for (const [path, field] of paths) {
              const texts = getTextAtPath(op.value, field);
              for (let i = 0; i < texts.length; i += 1) {
                const text = texts[i];
                const pathname = texts.length > 1 ? `${path}.${i}` : path;
                if (!toEmbed[text]) toEmbed[text] = [];
                toEmbed[text].push([op.namespace, op.key, pathname]);
              }
            }
          }

          if (Object.keys(toEmbed).length > 0) {
            const embeddings = await this.indexConfig.embeddings.embedDocuments(
              Object.keys(toEmbed)
            );

            const vectorValues: string[] = [];
            const vectorParams: string[] = [];
            let vectorParamIndex = 1;

            for (const [text, metadata] of Object.entries(toEmbed)) {
              const embedding = embeddings.shift();
              if (!embedding) {
                throw new Error(`No embedding found for text: ${text}`);
              }

              for (const [namespace, key, field] of metadata) {
                vectorValues.push(
                  `($${vectorParamIndex}, $${vectorParamIndex + 1}, $${
                    vectorParamIndex + 2
                  }, $${vectorParamIndex + 3}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
                );
                if (!Array.isArray(embedding) || embedding.some(v => typeof v !== 'number' || Number.isNaN(v))) {
                  throw new Error(`Invalid embedding format: ${JSON.stringify(embedding)}`);
                }
                vectorParams.push(
                  this.namespaceToText(namespace),
                  key,
                  field,
                  JSON.stringify(embedding)
                );
                vectorParamIndex += 4;
              }
            }

            await client.query(
              `
              INSERT INTO store_vectors 
                (prefix, key, field_name, embedding, created_at, updated_at)
              VALUES ${vectorValues.join(",")}
              ON CONFLICT (prefix, key, field_name) DO UPDATE
              SET embedding = EXCLUDED.embedding::vector,
                  updated_at = CURRENT_TIMESTAMP
              `,
              vectorParams
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async batchSearchOps(
    searchOps: Array<[number, SearchOperation]>,
    results: SearchItem[][]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const [idx, op] of searchOps) {
        let query = `
          SELECT prefix, key, value, created_at, updated_at
          FROM store
          WHERE prefix LIKE $1
        `;
        const params: unknown[] = [`${this.namespaceToText(op.namespacePrefix)}%`];
        let paramIndex = 2;

        // Add filter conditions
        const filterConditions: string[] = [];
        if (op.filter) {
          for (const [key, value] of Object.entries(op.filter)) {
            if (typeof value === "object" && value !== null) {
              for (const [opName, val] of Object.entries(value)) {
                const [condition, filterParams] = this.getFilterCondition(
                  key,
                  opName,
                  val,
                  paramIndex
                );
                filterConditions.push(condition);
                params.push(...filterParams);
                paramIndex += filterParams.length;
              }
            } else {
              filterConditions.push(`value->$${paramIndex} = $${paramIndex + 1}::jsonb`);
              params.push(key, JSON.stringify(value));
              paramIndex += 2;
            }
          }
          if (filterConditions.length > 0) {
            query += ` AND ${filterConditions.join(" AND ")}`;
          }
        }

        // Vector search
        if (op.query && this.indexConfig?.embeddings) {
          const embedding = await this.indexConfig.embeddings.embedQuery(op.query);

          const vectorParamIndex = paramIndex;  // Store the index for the vector parameter
          query = `
            WITH scored AS (
              SELECT s.prefix, s.key, s.value, s.created_at, s.updated_at,
                      1 - (sv.embedding <=> $${vectorParamIndex}::vector) as score
              FROM store s
              JOIN store_vectors sv ON s.prefix = sv.prefix AND s.key = sv.key
              WHERE s.prefix LIKE $1
              ${filterConditions.length > 0 ? `AND ${filterConditions.join(" AND ")}` : ""}
              ORDER BY score DESC
              LIMIT $${vectorParamIndex + 1}
              OFFSET $${vectorParamIndex + 2}
            )
            SELECT DISTINCT ON (prefix, key)
              prefix, key, value, created_at, updated_at, score
            FROM scored
            ORDER BY prefix, key, score DESC
          `;
          
          params.push(JSON.stringify(embedding));      // $vectorParamIndex
          params.push(op.limit ?? 10); // $vectorParamIndex + 1
          params.push(op.offset ?? 0); // $vectorParamIndex + 2
        } else {
          // Regular search
          query += ` ORDER BY updated_at DESC LIMIT $${paramIndex} OFFSET $${
            paramIndex + 1
          }`;
          params.push(op.limit ?? 10);
          params.push(op.offset ?? 0);
        }

        const { rows } = await client.query<Row>(query, params);
        this.updateResults(
          results, 
          idx, 
          rows.map(row => this.createSearchResult(row))
        );
      }
    } finally {
      client.release();
    }
  }

  private getFilterCondition(
    key: string,
    op: string,
    value: unknown,
    startIndex: number
  ): [string, unknown[]] {
    switch (op) {
      case "$eq":
        return [`value->$${startIndex} = $${startIndex + 1}::jsonb`, [key, JSON.stringify(value)]];
      case "$gt":
        return [`value->>$${startIndex} > $${startIndex + 1}`, [key, String(value)]];
      case "$gte":
        return [`value->>$${startIndex} >= $${startIndex + 1}`, [key, String(value)]];
      case "$lt":
        return [`value->>$${startIndex} < $${startIndex + 1}`, [key, String(value)]];
      case "$lte":
        return [`value->>$${startIndex} <= $${startIndex + 1}`, [key, String(value)]];
      case "$ne":
        return [`value->$${startIndex} != $${startIndex + 1}::jsonb`, [key, JSON.stringify(value)]];
      default:
        throw new Error(`Unsupported operator: ${op}`);
    }
  }

  private async batchListNamespacesOps(
    listOps: Array<[number, ListNamespacesOperation]>,
    results: string[][][]
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      for (const [idx, op] of listOps) {
        let query = `
          SELECT DISTINCT ON (truncated_prefix) truncated_prefix
          FROM (
            SELECT
              CASE
                WHEN $1::integer IS NOT NULL THEN
                  (
                    SELECT STRING_AGG(part, '.' ORDER BY idx)
                    FROM (
                      SELECT part, ROW_NUMBER() OVER () AS idx
                      FROM UNNEST(REGEXP_SPLIT_TO_ARRAY(prefix, '\\.')) AS part
                      LIMIT $1::integer
                    ) subquery
                  )
                ELSE prefix
              END AS truncated_prefix
            FROM store
        `;
        const params: unknown[] = [op.maxDepth];

        // Add match conditions
        if (op.matchConditions?.length) {
          const conditions: string[] = [];
          let paramIndex = 2;

          for (const condition of op.matchConditions) {
            if (condition.matchType === "prefix") {
              conditions.push(`prefix LIKE $${paramIndex}`);
              params.push(
                `${this.namespaceToText(condition.path, true)}%`
              );
            } else if (condition.matchType === "suffix") {
              conditions.push(`prefix LIKE $${paramIndex}`);
              params.push(
                `%${this.namespaceToText(condition.path, true)}`
              );
            }
            paramIndex += 1;
          }

          if (conditions.length) {
            query += ` WHERE ${conditions.join(" AND ")}`;
          }
        }

        query += `) AS subquery ORDER BY truncated_prefix LIMIT $${
          params.length + 1
        } OFFSET $${params.length + 2}`;
        params.push(op.limit ?? 100, op.offset ?? 0);

        const { rows } = await client.query<{ truncated_prefix: string }>(query, params);
        this.updateResults(
          results,
          idx,
          rows.map(row => row.truncated_prefix.split("."))
        );
      }
    } finally {
      client.release();
    }
  }

  async batch<Op extends readonly Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results: (Item | null | SearchItem[] | string[][])[] = new Array(operations.length).fill(null);
    
    // Group operations by type
    const getOps: Array<[number, GetOperation]> = [];
    const putOps: Array<[number, PutOperation]> = [];
    const searchOps: Array<[number, SearchOperation]> = [];
    const listOps: Array<[number, ListNamespacesOperation]> = [];

    operations.forEach((op, idx) => {
      if ("key" in op && "namespace" in op && !("value" in op)) {
        getOps.push([idx, op]);
      } else if ("value" in op) {
        putOps.push([idx, op]);
      } else if ("namespacePrefix" in op) {
        searchOps.push([idx, op]);
      } else if ("matchConditions" in op) {
        listOps.push([idx, op]);
      }
    });

    // Execute operations in parallel where possible
    await Promise.all([
      getOps.length && this.batchGetOps(getOps, results as (Item | null)[]),
      putOps.length && this.batchPutOps(putOps),
      searchOps.length && this.batchSearchOps(searchOps, results as SearchItem[][]),
      listOps.length && this.batchListNamespacesOps(listOps, results as string[][][]),
    ]);

    return results as OperationResults<Op>;
  }

  async stop(): Promise<void> {
    await this.pool.end();
  }
}
