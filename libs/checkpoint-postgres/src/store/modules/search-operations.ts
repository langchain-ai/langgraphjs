import pg from "pg";
import {
  type Item,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";
import { DatabaseCore } from "./database-core.js";
import { VectorOperations } from "./vector-operations.js";
import { QueryBuilder } from "./query-builder.js";
import { SearchOptions, SearchItem } from "./types.js";
import { validateNamespace } from "./utils.js";

/**
 * Handles all search operations: basic search, vector search, hybrid search.
 */
export class SearchOperations {
  constructor(
    private core: DatabaseCore,
    private vectorOps: VectorOperations
  ) {}

  async executeSearch(
    client: pg.PoolClient,
    operation: SearchOperation
  ): Promise<Item[]> {
    validateNamespace(operation.namespacePrefix);

    const namespacePath = operation.namespacePrefix.join(":");
    const { filter, limit = 10, offset = 0, query } = operation;

    // If vector search is configured and query is provided, use vector similarity search
    if (query && this.core.indexConfig) {
      return this.executeVectorSearch(client, operation);
    }

    // If query is provided but no vector search, use text search for better results
    if (query && !this.core.indexConfig) {
      const results = await this.textSearch(operation.namespacePrefix, {
        query,
        filter,
        limit,
        offset,
      });

      // Convert SearchItem[] to Item[] for consistent return type
      return results.map((item) => ({
        namespace: item.namespace,
        key: item.key,
        value: item.value,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }));
    }

    // Basic metadata search without query
    let sqlQuery = `
      SELECT namespace_path, key, value, created_at, updated_at
      FROM "${this.core.schema}".store
      WHERE namespace_path LIKE $1
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `;

    const params: unknown[] = [`${namespacePath}%`];
    let paramIndex = 2;

    // Add filter conditions using advanced filtering
    if (filter && Object.keys(filter).length > 0) {
      const { conditions, newParamIndex } = QueryBuilder.buildFilterConditions(
        filter,
        params,
        paramIndex
      );
      if (conditions.length > 0) {
        sqlQuery += ` AND (${conditions.join(" AND ")})`;
        paramIndex = newParamIndex;
      }
    }

    sqlQuery += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${
      paramIndex + 1
    }`;
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

  async executeVectorSearch(
    client: pg.PoolClient,
    operation: SearchOperation
  ): Promise<Item[]> {
    if (!this.core.indexConfig || !operation.query) return [];

    validateNamespace(operation.namespacePrefix);

    const namespacePath = operation.namespacePrefix.join(":");
    const { filter, limit = 10, offset = 0, query } = operation;

    // Generate query embedding
    const queryEmbedding = await this.vectorOps.generateQueryEmbedding(query);

    if (queryEmbedding.length !== this.core.indexConfig.dims) {
      throw new Error(
        `Query embedding dimension mismatch: expected ${this.core.indexConfig.dims}, got ${queryEmbedding.length}`
      );
    }

    let sqlQuery = `
      SELECT DISTINCT 
        s.namespace_path, 
        s.key, 
        s.value, 
        s.created_at, 
        s.updated_at,
        MIN(v.embedding <=> $2) as similarity_score
      FROM "${this.core.schema}".store s
      JOIN "${this.core.schema}".store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
      WHERE s.namespace_path LIKE $1
        AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
    `;

    const params: unknown[] = [
      `${namespacePath}%`,
      `[${queryEmbedding.join(",")}]`,
    ];
    let paramIndex = 3;

    // Add filter conditions
    if (filter && Object.keys(filter).length > 0) {
      const { conditions, newParamIndex } = QueryBuilder.buildFilterConditions(
        filter,
        params,
        paramIndex
      );
      if (conditions.length > 0) {
        // Adjust conditions to use 's.' prefix for store table columns
        const adjustedConditions = conditions.map((condition: string) =>
          condition.replace(/value ->/g, "s.value ->")
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

  async textSearch(
    namespacePrefix: string[],
    options: SearchOptions = {}
  ): Promise<SearchItem[]> {
    return this.core.withClient(async (client) => {
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
              ts_rank(to_tsvector($3::regconfig, value::text), plainto_tsquery($3::regconfig, $2::text))
            ELSE 0
          END as score
        FROM "${this.core.schema}".store
        WHERE namespace_path LIKE $1
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      `;

      const params: unknown[] = [
        `${namespacePath}%`,
        query || null,
        this.core.textSearchLanguage,
      ];
      let paramIndex = 4;

      // Add filter conditions using advanced filtering
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } =
          QueryBuilder.buildFilterConditions(filter, params, paramIndex);
        if (conditions.length > 0) {
          sqlQuery += ` AND (${conditions.join(" AND ")})`;
          paramIndex = newParamIndex;
        }
      }

      // Add full-text search if query is provided
      if (query) {
        sqlQuery += ` AND (
          to_tsvector($3::regconfig, value::text) @@ plainto_tsquery($3::regconfig, $2::text)
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
        createdAt: row.created_at || new Date(),
        updatedAt: row.updated_at || new Date(),
        score: row.score || undefined,
      }));

      // Refresh TTL for returned items if requested
      if (refreshTtl || this.core.ttlConfig?.refreshOnRead) {
        for (const item of items) {
          await this.core.refreshTtl(
            client,
            item.namespace.join(":"),
            item.key
          );
        }
      }

      return items;
    });
  }

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
    if (!this.core.indexConfig) {
      throw new Error(
        "Vector search not configured. Please provide an IndexConfig when creating the store."
      );
    }

    return this.core.withClient(async (client) => {
      validateNamespace(namespacePrefix);

      const namespacePath = namespacePrefix.join(":");
      const {
        filter,
        limit = 10,
        offset = 0,
        similarityThreshold = 0.0,
        distanceMetric = "cosine",
      } = options;

      // Generate query embedding
      const queryEmbedding = await this.vectorOps.generateQueryEmbedding(query);

      if (queryEmbedding.length !== this.core.indexConfig!.dims) {
        throw new Error(
          `Query embedding dimension mismatch: expected ${
            this.core.indexConfig!.dims
          }, got ${queryEmbedding.length}`
        );
      }

      // Choose distance operator based on metric
      let distanceOp: string;
      let scoreTransform: string;
      switch (distanceMetric) {
        case "l2":
          distanceOp = "<->";
          scoreTransform = "1 / (1 + MIN(v.embedding <-> $2))"; // Convert L2 distance to similarity
          break;
        case "inner_product":
          distanceOp = "<#>";
          scoreTransform = "MIN(v.embedding <#> $2)"; // Inner product (higher is better)
          break;
        case "cosine":
        default:
          distanceOp = "<=>";
          scoreTransform = "1 - MIN(v.embedding <=> $2)"; // Convert cosine distance to similarity
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
        FROM "${this.core.schema}".store s
        JOIN "${this.core.schema}".store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE s.namespace_path LIKE $1
          AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
      `;

      const params: unknown[] = [
        `${namespacePath}%`,
        `[${queryEmbedding.join(",")}]`,
      ];
      let paramIndex = 3;

      // Add similarity threshold
      if (similarityThreshold > 0) {
        if (distanceMetric === "inner_product") {
          sqlQuery += ` AND v.embedding <#> $2 >= $${paramIndex}`;
        } else {
          sqlQuery += ` AND v.embedding ${distanceOp} $2 <= $${paramIndex}`;
        }
        params.push(
          distanceMetric === "cosine"
            ? 1 - similarityThreshold
            : similarityThreshold
        );
        paramIndex += 1;
      }

      // Add filter conditions
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } =
          QueryBuilder.buildFilterConditions(filter, params, paramIndex);
        if (conditions.length > 0) {
          const adjustedConditions = conditions.map((condition: string) =>
            condition.replace(/value ->/g, "s.value ->")
          );
          sqlQuery += ` AND (${adjustedConditions.join(" AND ")})`;
          paramIndex = newParamIndex;
        }
      }

      const orderDirection = "DESC"; // From most similar to least similar
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
        createdAt: row.created_at || new Date(),
        updatedAt: row.updated_at || new Date(),
        score: parseFloat(row.similarity_score),
      }));
    });
  }

  async hybridSearch(
    namespacePrefix: string[],
    query: string,
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      vectorWeight?: number; // 0.0 to 1.0, weight for vector search vs text search
      similarityThreshold?: number;
    } = {}
  ): Promise<SearchItem[]> {
    if (!this.core.indexConfig) {
      throw new Error(
        "Vector search not configured. Please provide an IndexConfig when creating the store."
      );
    }

    return this.core.withClient(async (client) => {
      validateNamespace(namespacePrefix);

      const namespacePath = namespacePrefix.join(":");
      const {
        filter,
        limit = 10,
        offset = 0,
        vectorWeight = 0.7,
        similarityThreshold = 0.0,
      } = options;

      // Generate query embedding
      const queryEmbedding = await this.vectorOps.generateQueryEmbedding(query);

      if (queryEmbedding.length !== this.core.indexConfig!.dims) {
        throw new Error(
          `Query embedding dimension mismatch: expected ${
            this.core.indexConfig!.dims
          }, got ${queryEmbedding.length}`
        );
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
            (1 - $3) * ts_rank(to_tsvector($6::regconfig, s.value::text), plainto_tsquery($6::regconfig, $4))
          ) as hybrid_score
        FROM "${this.core.schema}".store s
        JOIN "${this.core.schema}".store_vectors v ON s.namespace_path = v.namespace_path AND s.key = v.key
        WHERE s.namespace_path LIKE $1
          AND (s.expires_at IS NULL OR s.expires_at > CURRENT_TIMESTAMP)
          AND (
            to_tsvector($6::regconfig, s.value::text) @@ plainto_tsquery($6::regconfig, $4)
            OR v.embedding <=> $2 <= $5
          )
      `;

      const params: unknown[] = [
        `${namespacePath}%`,
        `[${queryEmbedding.join(",")}]`,
        vectorWeight,
        query,
        1 - similarityThreshold,
        this.core.textSearchLanguage,
      ];
      let paramIndex = 7;

      // Add filter conditions
      if (filter && Object.keys(filter).length > 0) {
        const { conditions, newParamIndex } =
          QueryBuilder.buildFilterConditions(filter, params, paramIndex);
        if (conditions.length > 0) {
          const adjustedConditions = conditions.map((condition: string) =>
            condition.replace(/value ->/g, "s.value ->")
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
        createdAt: row.created_at || new Date(),
        updatedAt: row.updated_at || new Date(),
        score: parseFloat(row.hybrid_score),
      }));
    });
  }
}
