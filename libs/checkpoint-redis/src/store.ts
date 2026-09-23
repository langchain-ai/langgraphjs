import { createClient, createCluster } from "redis";

/** A conventional Redis connection. */
export type RedisClientConnection = ReturnType<typeof createClient>;

/** A clustered Redis connection. */
export type RedisClusterConnection = ReturnType<typeof createCluster>;

/** A Redis connection, clustered or conventional. */
export type RedisConnection = RedisClientConnection | RedisClusterConnection;
import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
import {
  type GetOperation,
  InvalidNamespaceError,
  type ListNamespacesOperation,
  type Operation,
  type PutOperation,
  type SearchOperation,
} from "@langchain/langgraph-checkpoint";

import {
  allOf,
  hasNamespaceLabels,
  isWithinNamespace,
  joinsUnambiguously,
  NAMESPACE_LABELS_SCHEMA,
  namespaceLabelsQuery,
  prefixTextQuery,
  prefixWildcardQuery,
} from "./namespace.js";
import { escapeRediSearchTagValue } from "./utils.js";

// Type guard functions for operations
export function isPutOperation(op: Operation): op is PutOperation {
  return "value" in op && "namespace" in op && "key" in op;
}

export function isGetOperation(op: Operation): op is GetOperation {
  return (
    "namespace" in op &&
    "key" in op &&
    !("value" in op) &&
    !("namespacePrefix" in op) &&
    !("matchConditions" in op)
  );
}

export function isSearchOperation(op: Operation): op is SearchOperation {
  return "namespacePrefix" in op;
}

export function isListNamespacesOperation(
  op: Operation
): op is ListNamespacesOperation {
  return "matchConditions" in op;
}

// Filter types for advanced search operations
export interface FilterOperators {
  $eq?: any;
  $ne?: any;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $in?: any[];
  $nin?: any[];
  $exists?: boolean;
}

export type FilterValue = any | FilterOperators;
export type Filter = Record<string, FilterValue>;

/**
 * Internal class for evaluating filters against documents.
 * Supports MongoDB-style query operators.
 */
class FilterBuilder {
  /**
   * Evaluates if a document matches the given filter criteria.
   * Supports advanced operators like $gt, $lt, $in, etc.
   */
  static matchesFilter(doc: Record<string, any>, filter: Filter): boolean {
    for (const [key, filterValue] of Object.entries(filter)) {
      if (!this.matchesFieldFilter(doc, key, filterValue)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Builds a Redis Search query string from filter criteria.
   * Note: This is limited by RediSearch capabilities and may not support all operators.
   */
  static buildRedisSearchQuery(
    filter: Filter,
    prefix?: string
  ): { query: string; useClientFilter: boolean } {
    const queryParts: string[] = [];
    let useClientFilter = false;

    // Add prefix filter if provided
    if (prefix) {
      const tokens = prefix.split(/[.-]/).filter((t) => t.length > 0);
      if (tokens.length > 0) {
        queryParts.push(`@prefix:(${tokens.join(" ")})`);
      }
    }

    // Check if we have complex operators that require client-side filtering
    for (const [_key, value] of Object.entries(filter)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).some((k) => k.startsWith("$"))
      ) {
        // Complex operators require client-side filtering
        useClientFilter = true;
        break;
      }
    }

    // If no prefix, at least search all documents
    if (queryParts.length === 0) {
      queryParts.push("*");
    }

    return {
      query: queryParts.join(" "),
      useClientFilter,
    };
  }

  private static matchesFieldFilter(
    doc: Record<string, any>,
    key: string,
    filterValue: FilterValue
  ): boolean {
    // Handle nested keys (e.g., "user.name")
    const actualValue = this.getNestedValue(doc, key);

    // Check if it's an operator object
    if (
      typeof filterValue === "object" &&
      filterValue !== null &&
      !Array.isArray(filterValue) &&
      Object.keys(filterValue).some((k) => k.startsWith("$"))
    ) {
      // Handle operator object
      return this.matchesOperators(actualValue, filterValue as FilterOperators);
    } else {
      // Simple equality check
      return this.isEqual(actualValue, filterValue);
    }
  }

  private static matchesOperators(
    actualValue: any,
    operators: FilterOperators
  ): boolean {
    for (const [operator, operatorValue] of Object.entries(operators)) {
      if (!this.matchesOperator(actualValue, operator, operatorValue)) {
        return false;
      }
    }
    return true;
  }

  private static matchesOperator(
    actualValue: any,
    operator: string,
    operatorValue: any
  ): boolean {
    switch (operator) {
      case "$eq":
        return this.isEqual(actualValue, operatorValue);

      case "$ne":
        return !this.isEqual(actualValue, operatorValue);

      case "$gt":
        return (
          actualValue !== undefined &&
          actualValue !== null &&
          Number(actualValue) > Number(operatorValue)
        );

      case "$gte":
        return (
          actualValue !== undefined &&
          actualValue !== null &&
          Number(actualValue) >= Number(operatorValue)
        );

      case "$lt":
        return (
          actualValue !== undefined &&
          actualValue !== null &&
          Number(actualValue) < Number(operatorValue)
        );

      case "$lte":
        return (
          actualValue !== undefined &&
          actualValue !== null &&
          Number(actualValue) <= Number(operatorValue)
        );

      case "$in":
        if (!Array.isArray(operatorValue)) return false;
        return operatorValue.some((val) => this.isEqual(actualValue, val));

      case "$nin":
        if (!Array.isArray(operatorValue)) return false;
        return !operatorValue.some((val) => this.isEqual(actualValue, val));

      case "$exists": {
        const exists = actualValue !== undefined;
        return operatorValue ? exists : !exists;
      }

      default:
        // Unknown operator, return false for safety
        return false;
    }
  }

  private static isEqual(a: any, b: any): boolean {
    // Handle null and undefined
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (a === undefined || b === undefined) return false;

    // Handle arrays
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((val, idx) => this.isEqual(val, b[idx]));
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      // Check if non-array value exists in array
      const arr = Array.isArray(a) ? a : b;
      const val = Array.isArray(a) ? b : a;
      return arr.includes(val);
    }

    // Handle objects
    if (typeof a === "object" && typeof b === "object") {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((key) => this.isEqual(a[key], b[key]));
    }

    // Primitive comparison (with type coercion for numbers)
    return a == b;
  }

  private static getNestedValue(obj: any, path: string): any {
    const keys = path.split(".");
    let current = obj;

    for (const key of keys) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[key];
    }

    return current;
  }
}

export interface Item {
  value: any;
  key: string;
  namespace: string[];
  created_at: Date;
  updated_at: Date;
}

export interface SearchItem extends Item {
  score?: number;
}

interface StoreDocument {
  key: string;
  prefix: string;
  value: any;
  created_at: number;
  updated_at: number;
}

interface VectorDocument {
  prefix: string;
  key: string;
  field_name: string;
  embedding: number[];
  created_at: number;
  updated_at: number;
}

export interface IndexConfig {
  dims: number;
  embed?: any;
  distanceType?: "cosine" | "l2" | "ip"; // cosine, L2 (Euclidean), inner product
  fields?: string[];
  vectorStorageType?: string;
  similarityThreshold?: number; // Minimum similarity score for results
}

export interface TTLConfig {
  defaultTTL?: number;
  refreshOnRead?: boolean;
}

export interface StoreConfig {
  index?: IndexConfig;
  ttl?: TTLConfig;
}

const REDIS_KEY_SEPARATOR = ":";
const STORE_PREFIX = "store";
const STORE_VECTOR_PREFIX = "store_vectors";

// A lookup pages through at most 10,000 candidates, Redis Stack's default
// MAXSEARCHRESULTS: asking it for more is an error.
const PAGE_SIZE = 100;
const MAX_CANDIDATES = 10_000;

// How often to ask whether Redis has finished indexing the labels field.
const LABELS_RECHECK_MS = 1000;

const SCHEMAS = [
  {
    index: "store",
    prefix: STORE_PREFIX + REDIS_KEY_SEPARATOR,
    schema: {
      "$.prefix": { type: "TEXT", AS: "prefix" },
      "$.key": { type: "TAG", AS: "key" },
      "$.created_at": { type: "NUMERIC", AS: "created_at" },
      "$.updated_at": { type: "NUMERIC", AS: "updated_at" },
    },
  },
  {
    index: "store_vectors",
    prefix: STORE_VECTOR_PREFIX + REDIS_KEY_SEPARATOR,
    schema: {
      "$.prefix": { type: "TEXT", AS: "prefix" },
      "$.key": { type: "TAG", AS: "key" },
      "$.field_name": { type: "TAG", AS: "field_name" },
      "$.embedding": { type: "VECTOR", AS: "embedding" },
      "$.created_at": { type: "NUMERIC", AS: "created_at" },
      "$.updated_at": { type: "NUMERIC", AS: "updated_at" },
    },
  },
];

export class RedisStore {
  private readonly client: RedisConnection;
  private readonly indexConfig?: IndexConfig;
  private readonly ttlConfig?: TTLConfig;
  private readonly embeddings?: any;

  /**
   * Whether queries can narrow by the namespace labels field. setup() adds
   * it, then Redis indexes existing documents into it in the background, and
   * a query made before that finishes would miss them. Until it is "ready",
   * queries use the `@prefix` text match this store has always used.
   */
  private labels: "absent" | "indexing" | "ready" = "absent";

  private labelsCheckedAt = 0;

  constructor(client: RedisConnection, config?: StoreConfig) {
    this.client = client;
    this.indexConfig = config?.index;
    this.ttlConfig = config?.ttl;

    if (this.indexConfig?.embed) {
      this.embeddings = this.indexConfig.embed;
    }
  }

  static async fromConnString(
    connString: string,
    config?: StoreConfig
  ): Promise<RedisStore> {
    const client = createClient({ url: connString });
    await client.connect();
    const store = new RedisStore(client, config);
    await store.setup();
    return store;
  }

  static async fromCluster(
    rootNodes: Array<{ url: string }>,
    config?: StoreConfig
  ): Promise<RedisStore> {
    const client = createCluster({ rootNodes });
    await client.connect();
    const store = new RedisStore(client, config);
    await store.setup();
    return store;
  }

  async setup(): Promise<void> {
    // Create store index
    try {
      await this.client.ft.create(SCHEMAS[0].index, SCHEMAS[0].schema as any, {
        ON: "JSON",
        PREFIX: SCHEMAS[0].prefix,
      });
    } catch (error: any) {
      if (!error.message?.includes("Index already exists")) {
        console.error("Failed to create store index:", error.message);
      }
    }

    // Create vector index if configured
    if (this.indexConfig) {
      const dims = this.indexConfig.dims;
      const distanceMetric =
        this.indexConfig.distanceType === "cosine"
          ? "COSINE"
          : this.indexConfig.distanceType === "l2"
            ? "L2"
            : this.indexConfig.distanceType === "ip"
              ? "IP"
              : "COSINE";

      // Build schema with correct vector syntax
      const vectorSchema: Record<string, any> = {
        "$.prefix": { type: "TEXT", AS: "prefix" },
        "$.key": { type: "TAG", AS: "key" },
        "$.field_name": { type: "TAG", AS: "field_name" },
        "$.created_at": { type: "NUMERIC", AS: "created_at" },
        "$.updated_at": { type: "NUMERIC", AS: "updated_at" },
      };

      // Add vector field with correct syntax
      vectorSchema["$.embedding"] = {
        type: "VECTOR",
        ALGORITHM: "FLAT",
        TYPE: "FLOAT32",
        DIM: dims,
        DISTANCE_METRIC: distanceMetric,
        AS: "embedding",
      };

      try {
        await this.client.ft.create(SCHEMAS[1].index, vectorSchema as any, {
          ON: "JSON",
          PREFIX: SCHEMAS[1].prefix,
        });
      } catch (error: any) {
        if (!error.message?.includes("Index already exists")) {
          console.error("Failed to create vector index:", error.message);
        }
      }
    }

    await this.addNamespaceLabels();
  }

  async get(
    namespace: string[],
    key: string,
    options?: { refreshTTL?: boolean }
  ): Promise<Item | null> {
    // No document is stored under a dotted label; its prefix names another
    // namespace's documents.
    if (!joinsUnambiguously(namespace)) {
      return null;
    }

    try {
      const doc = await this.findDocument(namespace, key);
      if (!doc) {
        return null;
      }

      const jsonDoc = doc.value as unknown as StoreDocument;
      const docId = doc.id;

      // Refresh TTL if requested
      if (options?.refreshTTL) {
        await this.refreshItemTTL(docId);
      }

      return {
        value: jsonDoc.value,
        key: jsonDoc.key,
        namespace: jsonDoc.prefix.split("."),
        created_at: new Date(jsonDoc.created_at / 1000000),
        updated_at: new Date(jsonDoc.updated_at / 1000000),
      };
    } catch (error: any) {
      if (error.message?.includes("no such index")) {
        return null;
      }
      throw error;
    }
  }

  async put(
    namespace: string[],
    key: string,
    value: any,
    options?: { ttl?: number; index?: boolean | string[] }
  ): Promise<void> {
    // Validate namespace for put operations
    this.validateNamespace(namespace);
    const prefix = namespace.join(".");
    const docId = uuidv4();
    // Use high-resolution time for better timestamp precision
    const now = Date.now() * 1000000 + Math.floor(performance.now() * 1000); // Microseconds + nanoseconds component
    let createdAt = now; // Will be overridden if document exists

    // Delete existing document if it exists
    try {
      const existing = await this.findDocument(namespace, key);
      if (existing) {
        const oldDocId = existing.id;
        // Preserve the original created_at timestamp
        const existingDoc = await this.client.json.get(oldDocId);
        if (
          existingDoc &&
          typeof existingDoc === "object" &&
          "created_at" in existingDoc
        ) {
          createdAt = (existingDoc as any).created_at;
        }
        await this.client.del(oldDocId);

        // Also delete associated vector if it exists
        if (this.indexConfig) {
          const oldUuid = oldDocId.split(":").pop();
          const oldVectorKey = `${STORE_VECTOR_PREFIX}${REDIS_KEY_SEPARATOR}${oldUuid}`;
          try {
            await this.client.del(oldVectorKey);
          } catch {
            // Vector might not exist
          }
        }
      }
    } catch {
      // Index might not exist yet
    }

    // Handle delete operation
    if (value === null) {
      return;
    }

    // Store the document
    const storeKey = `${STORE_PREFIX}${REDIS_KEY_SEPARATOR}${docId}`;
    const doc = {
      prefix,
      key,
      value,
      created_at: createdAt,
      updated_at: now,
    };

    await this.client.json.set(storeKey, "$", doc);

    // Handle embeddings if configured
    if (this.indexConfig && this.embeddings && options?.index !== false) {
      const fieldsToIndex =
        options && Array.isArray(options.index)
          ? options.index
          : this.indexConfig.fields || ["text"];
      const textsToEmbed = [];
      const fieldNames = [];

      for (const field of fieldsToIndex) {
        if (value[field]) {
          textsToEmbed.push(value[field]);
          fieldNames.push(field);
        }
      }

      if (textsToEmbed.length > 0) {
        const embeddings = await this.embeddings.embedDocuments(textsToEmbed);

        for (let i = 0; i < embeddings.length; i++) {
          const vectorKey = `${STORE_VECTOR_PREFIX}${REDIS_KEY_SEPARATOR}${docId}`;
          const vectorDoc: VectorDocument = {
            prefix,
            key,
            field_name: fieldNames[i],
            embedding: embeddings[i],
            created_at: now,
            updated_at: now,
          };

          await this.client.json.set(vectorKey, "$", vectorDoc as any);

          // Apply TTL to vector key if configured
          const ttlMinutes = options?.ttl || this.ttlConfig?.defaultTTL;
          if (ttlMinutes) {
            const ttlSeconds = Math.floor(ttlMinutes * 60);
            await this.client.expire(vectorKey, ttlSeconds);
          }
        }
      }
    }

    // Apply TTL if configured
    const ttlMinutes = options?.ttl || this.ttlConfig?.defaultTTL;
    if (ttlMinutes) {
      const ttlSeconds = Math.floor(ttlMinutes * 60);
      await this.client.expire(storeKey, ttlSeconds);
    }
  }

  async delete(namespace: string[], key: string): Promise<void> {
    await this.put(namespace, key, null);
  }

  async search(
    namespacePrefix: string[],
    options?: {
      filter?: Filter;
      query?: string;
      limit?: number;
      offset?: number;
      refreshTTL?: boolean;
      similarityThreshold?: number;
    }
  ): Promise<SearchItem[]> {
    const limit = options?.limit || 10;
    const offset = options?.offset || 0;

    // No document is stored under a dotted label; its prefix names another
    // namespace's documents.
    if (!joinsUnambiguously(namespacePrefix)) {
      return [];
    }

    // Handle vector search if query is provided
    if (options?.query && this.indexConfig && this.embeddings) {
      const [embedding] = await this.embeddings.embedDocuments([options.query]);

      // Build KNN query
      const queryStr = await this.namespaceQuery(
        namespacePrefix,
        prefixWildcardQuery
      );
      const vectorBytes = Buffer.from(new Float32Array(embedding).buffer);

      try {
        // Use KNN query with proper syntax
        const results = await this.client.ft.search(
          "store_vectors",
          `(${queryStr})=>[KNN ${limit} @embedding $BLOB]`,
          {
            PARAMS: {
              BLOB: vectorBytes,
            },
            DIALECT: 2,
            LIMIT: { from: offset, size: limit },
            RETURN: ["prefix", "key", "__embedding_score"],
          }
        );

        // Get matching store documents
        const items: SearchItem[] = [];
        for (const doc of results.documents) {
          const docUuid = doc.id.split(":").pop();
          const storeKey = `${STORE_PREFIX}${REDIS_KEY_SEPARATOR}${docUuid}`;

          const storeDoc = (await this.client.json.get(
            storeKey
          )) as StoreDocument | null;
          // The query only narrows the candidates; skip other namespaces
          if (storeDoc && isWithinNamespace(storeDoc.prefix, namespacePrefix)) {
            // Apply advanced filter if provided
            if (options.filter) {
              if (
                !FilterBuilder.matchesFilter(
                  storeDoc.value || {},
                  options.filter
                )
              ) {
                continue;
              }
            }

            // Refresh TTL if requested
            if (options.refreshTTL) {
              await this.refreshItemTTL(storeKey);
              await this.refreshItemTTL(doc.id);
            }

            const score = (doc.value as any)?.__embedding_score
              ? this.calculateSimilarityScore(
                  parseFloat((doc.value as any).__embedding_score as string)
                )
              : 0;

            // Apply similarity threshold if specified
            const threshold =
              options.similarityThreshold ??
              this.indexConfig?.similarityThreshold;
            if (threshold !== undefined && score < threshold) {
              continue;
            }

            items.push({
              value: storeDoc.value,
              key: storeDoc.key,
              namespace: storeDoc.prefix.split("."),
              created_at: new Date(storeDoc.created_at / 1000000),
              updated_at: new Date(storeDoc.updated_at / 1000000),
              score,
            });
          }
        }

        return items;
      } catch (error: any) {
        if (error.message?.includes("no such index")) {
          return [];
        }
        throw error;
      }
    }

    // Regular search without vectors
    const queryStr = await this.namespaceQuery(
      namespacePrefix,
      prefixTextQuery
    );

    try {
      const results = await this.client.ft.search("store", queryStr, {
        LIMIT: { from: offset, size: limit },
        SORTBY: { BY: "created_at", DIRECTION: "DESC" },
      });

      const items: SearchItem[] = [];
      for (const doc of results.documents) {
        const jsonDoc = doc.value as unknown as StoreDocument;

        // The query only narrows the candidates; skip other namespaces
        if (!isWithinNamespace(jsonDoc.prefix, namespacePrefix)) {
          continue;
        }

        // Apply advanced filter
        if (options?.filter) {
          if (
            !FilterBuilder.matchesFilter(jsonDoc.value || {}, options.filter)
          ) {
            continue;
          }
        }

        // Refresh TTL if requested
        if (options?.refreshTTL) {
          await this.refreshItemTTL(doc.id);
        }

        items.push({
          value: jsonDoc.value,
          key: jsonDoc.key,
          namespace: jsonDoc.prefix.split("."),
          created_at: new Date(jsonDoc.created_at / 1000000),
          updated_at: new Date(jsonDoc.updated_at / 1000000),
        });
      }

      return items;
    } catch (error: any) {
      if (error.message?.includes("no such index")) {
        return [];
      }
      throw error;
    }
  }

  async listNamespaces(options?: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    const query = "*";

    try {
      const results = await this.client.ft.search("store", query, {
        LIMIT: { from: 0, size: 1000 }, // Get many to deduplicate
        RETURN: ["prefix"],
      });

      // Extract unique namespaces and filter
      const namespaceSet = new Set<string>();
      for (const doc of results.documents) {
        const prefix = (doc.value as unknown as StoreDocument).prefix;
        const parts = prefix.split(".");

        // Apply prefix filter if specified
        if (options?.prefix) {
          // Check if this namespace starts with the specified prefix
          if (parts.length < options.prefix.length) continue;

          let matches = true;
          for (let i = 0; i < options.prefix.length; i++) {
            if (parts[i] !== options.prefix[i]) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        // Apply suffix filter if specified
        if (options?.suffix) {
          // Check if this namespace ends with the specified suffix
          if (parts.length < options.suffix.length) continue;

          let matches = true;
          const startIdx = parts.length - options.suffix.length;
          for (let i = 0; i < options.suffix.length; i++) {
            if (parts[startIdx + i] !== options.suffix[i]) {
              matches = false;
              break;
            }
          }
          if (!matches) continue;
        }

        // Apply max depth
        if (options?.maxDepth) {
          const truncated = parts.slice(0, options.maxDepth);
          namespaceSet.add(truncated.join("."));
        } else {
          namespaceSet.add(prefix);
        }
      }

      // Convert to array of arrays and sort
      let namespaces = Array.from(namespaceSet)
        .map((ns) => ns.split("."))
        .sort((a, b) => a.join(".").localeCompare(b.join(".")));

      // Apply pagination
      if (options?.offset || options?.limit) {
        const offset = options.offset || 0;
        const limit = options.limit || 10;
        namespaces = namespaces.slice(offset, offset + limit);
      }

      return namespaces;
    } catch (error: any) {
      if (error.message?.includes("no such index")) {
        return [];
      }
      throw error;
    }
  }

  async batch(ops: Operation[]): Promise<any[]> {
    const results: any[] = new Array(ops.length).fill(null);

    // Process operations in order to maintain dependencies
    for (let idx = 0; idx < ops.length; idx++) {
      const op = ops[idx];

      // Execute operation based on type guards
      if (isPutOperation(op)) {
        // TypeScript now knows op is PutOperation
        await this.put(op.namespace, op.key, op.value);
        results[idx] = null;
      } else if (isSearchOperation(op)) {
        // TypeScript now knows op is SearchOperation
        results[idx] = await this.search(op.namespacePrefix, {
          filter: op.filter,
          query: op.query,
          limit: op.limit,
          offset: op.offset,
        });
      } else if (isListNamespacesOperation(op)) {
        // TypeScript now knows op is ListNamespacesOperation
        let prefix: string[] | undefined = undefined;
        let suffix: string[] | undefined = undefined;

        if (op.matchConditions) {
          for (const condition of op.matchConditions) {
            if (condition.matchType === "prefix") {
              prefix = condition.path;
            } else if (condition.matchType === "suffix") {
              suffix = condition.path;
            }
          }
        }

        results[idx] = await this.listNamespaces({
          prefix,
          suffix,
          maxDepth: op.maxDepth,
          limit: op.limit,
          offset: op.offset,
        });
      } else if (isGetOperation(op)) {
        // TypeScript now knows op is GetOperation
        results[idx] = await this.get(op.namespace, op.key);
      } else {
        // This should never happen with proper Operation type
        throw new Error(`Unknown operation type: ${JSON.stringify(op)}`);
      }
    }

    return results;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Get statistics about the store.
   * Returns document counts and other metrics.
   */
  async getStatistics(): Promise<{
    totalDocuments: number;
    namespaceCount: number;
    vectorDocuments?: number;
    indexInfo?: Record<string, any>;
  }> {
    const stats: {
      totalDocuments: number;
      namespaceCount: number;
      vectorDocuments?: number;
      indexInfo?: Record<string, any>;
    } = {
      totalDocuments: 0,
      namespaceCount: 0,
    };

    try {
      // Get total document count
      const countResult = await this.client.ft.search("store", "*", {
        LIMIT: { from: 0, size: 0 },
      });
      stats.totalDocuments = countResult.total || 0;

      // Get unique namespace count
      const namespaces = await this.listNamespaces({ limit: 1000 });
      stats.namespaceCount = namespaces.length;

      // Get vector document count if index is configured
      if (this.indexConfig) {
        try {
          const vectorResult = await this.client.ft.search(
            "store_vectors",
            "*",
            {
              LIMIT: { from: 0, size: 0 },
            }
          );
          stats.vectorDocuments = vectorResult.total || 0;
        } catch {
          // Vector index might not exist
          stats.vectorDocuments = 0;
        }

        // Get index info
        try {
          stats.indexInfo = await this.client.ft.info("store");
        } catch {
          // Index info might not be available
        }
      }
    } catch (error: any) {
      if (!error.message?.includes("no such index")) {
        throw error;
      }
    }

    return stats;
  }

  private validateNamespace(namespace: string[]): void {
    if (namespace.length === 0) {
      throw new InvalidNamespaceError("Namespace cannot be empty.");
    }
    for (const label of namespace) {
      // Runtime check for JavaScript users (TypeScript already ensures this)
      // This check is for runtime safety when called from JavaScript
      // noinspection SuspiciousTypeOfGuard
      if (typeof label !== "string") {
        throw new InvalidNamespaceError(
          `Invalid namespace label '${String(
            label
          )}' found in ${namespace}. Namespace labels must be strings.`
        );
      }
      if (label.includes(".")) {
        throw new InvalidNamespaceError(
          `Invalid namespace label '${label}' found in ${namespace}. Namespace labels cannot contain periods ('.').`
        );
      }
      if (label === "") {
        throw new InvalidNamespaceError(
          `Namespace labels cannot be empty strings. Got ${label} in ${namespace}`
        );
      }
    }
    if (namespace[0] === "langgraph") {
      throw new InvalidNamespaceError(
        `Root label for namespace cannot be "langgraph". Got: ${namespace}`
      );
    }
  }

  /**
   * Find the document stored under exactly `namespace` and `key`. The query
   * only narrows the candidates, so page through them to the one that matches.
   */
  private async findDocument(namespace: string[], key: string) {
    const prefix = namespace.join(".");
    // An empty key has no tag to match; the comparison below checks it
    const keyQuery = key === "" ? "*" : `@key:{${this.escapeTagValue(key)}}`;
    const query = allOf(
      await this.namespaceQuery(namespace, prefixTextQuery),
      keyQuery
    );

    for (let from = 0; from < MAX_CANDIDATES; from += PAGE_SIZE) {
      const page = await this.client.ft.search("store", query, {
        LIMIT: { from, size: PAGE_SIZE },
      });
      const match = page.documents.find((doc) => {
        const found = doc.value as unknown as StoreDocument;
        return found.prefix === prefix && found.key === key;
      });
      if (match || page.documents.length < PAGE_SIZE) {
        return match;
      }
    }
    return undefined;
  }

  /**
   * Query clause narrowing to documents that may be in `namespace`: the labels
   * field once it is ready, the text query `fallback` builds until then.
   */
  private async namespaceQuery(
    namespace: string[],
    fallback: (namespace: string[]) => string
  ): Promise<string> {
    return (await this.labelsReady())
      ? namespaceLabelsQuery(namespace)
      : fallback(namespace);
  }

  /**
   * Add the labels field to each index that lacks it. If that fails, queries
   * keep using the text match, so setup() never fails because of it.
   */
  private async addNamespaceLabels(): Promise<void> {
    this.labels = "absent";
    // node-redis sends FT.ALTER and FT.INFO to any cluster node, not the one
    // that answers FT.SEARCH, so a cluster keeps the text match.
    if ("masters" in this.client) {
      return;
    }
    try {
      for (const index of this.indexNames()) {
        if (!hasNamespaceLabels(await this.indexInfo(index))) {
          // Fails if another client added it first; the check below decides.
          await this.client.ft
            .alter(index, NAMESPACE_LABELS_SCHEMA as any)
            .catch(() => undefined);
        }
      }
      this.labels = "indexing";
      await this.checkNamespaceLabels();
    } catch {
      this.labels = "absent";
    }
  }

  /** Whether queries can use the labels field yet. */
  private async labelsReady(): Promise<boolean> {
    if (
      this.labels === "indexing" &&
      Date.now() - this.labelsCheckedAt >= LABELS_RECHECK_MS
    ) {
      await this.checkNamespaceLabels().catch(() => undefined);
    }
    return this.labels === "ready";
  }

  /** Mark the field ready once every index has it and has indexed into it. */
  private async checkNamespaceLabels(): Promise<void> {
    this.labelsCheckedAt = Date.now();
    const infos = await Promise.all(
      this.indexNames().map((index) => this.indexInfo(index))
    );
    if (!infos.every(hasNamespaceLabels)) {
      this.labels = "absent";
    } else if (infos.every((info) => Number(info.indexing) === 0)) {
      this.labels = "ready";
    }
  }

  private indexNames(): string[] {
    return this.indexConfig ? ["store", "store_vectors"] : ["store"];
  }

  /**
   * FT.INFO as a map. node-redis's own parser reads the reply by position,
   * which newer RediSearch versions changed, so its `indexing` is wrong.
   */
  private async indexInfo(index: string): Promise<Record<string, unknown>> {
    // Only a single-node connection gets here; see addNamespaceLabels
    const client = this.client as RedisClientConnection;
    const reply = (await client.sendCommand(["FT.INFO", index])) as unknown[];
    const info: Record<string, unknown> = {};
    for (let i = 0; i + 1 < reply.length; i += 2) {
      info[String(reply[i])] = reply[i + 1];
    }
    return info;
  }

  private async refreshItemTTL(docId: string): Promise<void> {
    if (this.ttlConfig?.defaultTTL) {
      const ttlSeconds = Math.floor(this.ttlConfig.defaultTTL * 60);
      await this.client.expire(docId, ttlSeconds);

      // Also refresh vector key if it exists
      const docUuid = docId.split(":").pop();
      const vectorKey = `${STORE_VECTOR_PREFIX}${REDIS_KEY_SEPARATOR}${docUuid}`;
      try {
        await this.client.expire(vectorKey, ttlSeconds);
      } catch {
        // Vector key might not exist
      }
    }
  }

  private escapeTagValue(value: string): string {
    // Delegate to shared utility for RediSearch TAG field escaping
    return escapeRediSearchTagValue(value);
  }

  /**
   * Calculate similarity score based on the distance metric.
   * Converts raw distance to a normalized similarity score [0,1].
   */
  private calculateSimilarityScore(distance: number): number {
    const metric = this.indexConfig?.distanceType || "cosine";

    switch (metric) {
      case "cosine":
        // Cosine distance is in range [0,2], convert to similarity [0,1]
        return Math.max(0, 1 - distance / 2);

      case "l2":
        // L2 (Euclidean) distance, use exponential decay
        // Similarity = e^(-distance)
        return Math.exp(-distance);

      case "ip":
        // Inner product can be negative, use sigmoid function
        // Similarity = 1 / (1 + e^(-distance))
        return 1 / (1 + Math.exp(-distance));

      default:
        // Default to cosine similarity
        return Math.max(0, 1 - distance / 2);
    }
  }
}

// Export FilterBuilder for testing purposes
export { FilterBuilder };
