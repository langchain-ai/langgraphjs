/* eslint-disable @typescript-eslint/no-explicit-any */
import { Embeddings } from "@langchain/core/embeddings";

/**
 * Error thrown when an invalid namespace is provided.
 */
export class InvalidNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNamespaceError";
  }
}

/**
 * Validates the provided namespace.
 * @param namespace The namespace to validate.
 * @throws {InvalidNamespaceError} If the namespace is invalid.
 */
function validateNamespace(namespace: string[]): void {
  if (namespace.length === 0) {
    throw new InvalidNamespaceError("Namespace cannot be empty.");
  }
  for (const label of namespace) {
    if (typeof label !== "string") {
      throw new InvalidNamespaceError(
        `Invalid namespace label '${label}' found in ${namespace}. Namespace labels ` +
          `must be strings, but got ${typeof label}.`
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
 * Represents a stored item with metadata.
 */
export interface Item {
  /**
   * The stored data as an object. Keys are filterable.
   */
  value: Record<string, any>;
  /**
   * Unique identifier within the namespace.
   */
  key: string;
  /**
   * Hierarchical path defining the collection in which this document resides.
   * Represented as an array of strings, allowing for nested categorization.
   * For example: ["documents", "user123"]
   */
  namespace: string[];
  /**
   * Timestamp of item creation.
   */
  createdAt: Date;
  /**
   * Timestamp of last update.
   */
  updatedAt: Date;
}

/**
 * Represents a search result item with relevance score.
 * Extends the base Item interface with an optional similarity score.
 */
export interface SearchItem extends Item {
  /**
   * Relevance/similarity score if from a ranked operation.
   * Higher scores indicate better matches.
   *
   * This is typically a cosine similarity score between -1 and 1,
   * where 1 indicates identical vectors and -1 indicates opposite vectors.
   */
  score?: number;
}

/**
 * Operation to retrieve an item by namespace and ID.
 */
export interface GetOperation {
  /**
   * Hierarchical path for the item.
   *
   * @example
   * // Get a user profile
   * namespace: ["users", "profiles"]
   */
  namespace: string[];

  /**
   * Unique identifier within the namespace.
   * Together with namespace forms the complete path to the item.
   *
   * @example
   * key: "user123"  // For a user profile
   * key: "doc456"   // For a document
   */
  key: string;
}

/**
 * Operation to search for items within a namespace prefix.
 */
export interface SearchOperation {
  /**
   * Hierarchical path prefix to search within.
   * Only items under this prefix will be searched.
   *
   * @example
   * // Search all user documents
   * namespacePrefix: ["users", "documents"]
   *
   * // Search everything
   * namespacePrefix: []
   */
  namespacePrefix: string[];

  /**
   * Key-value pairs to filter results based on exact matches or comparison operators.
   *
   * Supports both exact matches and operator-based comparisons:
   * - $eq: Equal to (same as direct value comparison)
   * - $ne: Not equal to
   * - $gt: Greater than
   * - $gte: Greater than or equal to
   * - $lt: Less than
   * - $lte: Less than or equal to
   *
   * @example
   * // Exact match
   * filter: { status: "active" }
   *
   * // With operators
   * filter: { score: { $gt: 4.99 } }
   *
   * // Multiple conditions
   * filter: {
   *   score: { $gte: 3.0 },
   *   color: "red"
   * }
   */
  filter?: Record<string, any>;

  /**
   * Maximum number of items to return.
   * @default 10
   */
  limit?: number;

  /**
   * Number of items to skip before returning results.
   * Useful for pagination.
   * @default 0
   */
  offset?: number;

  /**
   * Natural language search query for semantic search.
   * When provided, results will be ranked by relevance to this query
   * using vector similarity search.
   *
   * @example
   * // Find technical documentation about APIs
   * query: "technical documentation about REST APIs"
   *
   * // Find recent ML papers
   * query: "machine learning papers from 2023"
   */
  query?: string;
}

/**
 * Operation to store, update, or delete an item.
 */
export interface PutOperation {
  /**
   * Hierarchical path for the item.
   * Acts as a folder-like structure to organize items.
   * Each element represents one level in the hierarchy.
   *
   * @example
   * // Root level documents
   * namespace: ["documents"]
   *
   * // User-specific documents
   * namespace: ["documents", "user123"]
   *
   * // Nested cache structure
   * namespace: ["cache", "docs", "v1"]
   */
  namespace: string[];

  /**
   * Unique identifier for the document within its namespace.
   * Together with namespace forms the complete path to the item.
   *
   * Example: If namespace is ["documents", "user123"] and key is "report1",
   * the full path would effectively be "documents/user123/report1"
   */
  key: string;

  /**
   * Data to be stored, or null to delete the item.
   * Must be a JSON-serializable object with string keys.
   * Setting to null signals that the item should be deleted.
   *
   * @example
   * {
   *   field1: "string value",
   *   field2: 123,
   *   nested: { can: "contain", any: "serializable data" }
   * }
   */
  value: Record<string, any> | null;

  /**
   * Controls how the item's fields are indexed for search operations.
   *
   * - undefined: Uses store's default indexing configuration
   * - false: Disables indexing for this item
   * - string[]: List of field paths to index
   *
   * Path syntax supports:
   * - Nested fields: "metadata.title"
   * - Array access: "chapters[*].content" (each indexed separately)
   * - Specific indices: "authors[0].name"
   *
   * @example
   * // Index specific fields
   * index: ["metadata.title", "chapters[*].content"]
   *
   * // Disable indexing
   * index: false
   */
  index?: false | string[];
}

/**
 * Operation to list and filter namespaces in the store.
 */
export interface ListNamespacesOperation {
  matchConditions?: MatchCondition[];
  maxDepth?: number;
  limit: number;
  offset: number;
}

export type NameSpacePath = (string | "*")[];

export type NamespaceMatchType = "prefix" | "suffix";

export interface MatchCondition {
  matchType: NamespaceMatchType;
  path: NameSpacePath;
}

export type Operation =
  | GetOperation
  | SearchOperation
  | PutOperation
  | ListNamespacesOperation;

export type OperationResults<Tuple extends readonly Operation[]> = {
  [K in keyof Tuple]: Tuple[K] extends PutOperation
    ? void
    : Tuple[K] extends SearchOperation
    ? SearchItem[]
    : Tuple[K] extends GetOperation
    ? Item | null
    : Tuple[K] extends ListNamespacesOperation
    ? string[][]
    : never;
};

/**
 * Configuration for indexing documents for semantic search in the store.
 *
 * This configures how documents are embedded and indexed for vector similarity search.
 */
export interface IndexConfig {
  /**
   * Number of dimensions in the embedding vectors.
   *
   * Common embedding model dimensions:
   * - OpenAI text-embedding-3-large: 256, 1024, or 3072
   * - OpenAI text-embedding-3-small: 512 or 1536
   * - OpenAI text-embedding-ada-002: 1536
   * - Cohere embed-english-v3.0: 1024
   * - Cohere embed-english-light-v3.0: 384
   * - Cohere embed-multilingual-v3.0: 1024
   * - Cohere embed-multilingual-light-v3.0: 384
   */
  dims: number;

  /**
   * The embeddings model to use for generating vectors.
   * This should be a LangChain Embeddings implementation.
   */
  embeddings: Embeddings;

  /**
   * Fields to extract text from for embedding generation.
   *
   * Path syntax supports:
   * - Simple field access: "field"
   * - Nested fields: "metadata.title"
   * - Array indexing:
   *   - All elements: "chapters[*].content"
   *   - Specific index: "authors[0].name"
   *   - Last element: "array[-1]"
   *
   * @default ["$"] Embeds the entire document as one vector
   */
  fields?: string[];
}

/**
 * Utility function to get text at a specific JSON path
 */
export function getTextAtPath(obj: any, path: string): string[] {
  const parts = path.split(".");
  let current: any = obj;

  for (const part of parts) {
    if (part.includes("[")) {
      const [arrayName, indexStr] = part.split("[");
      const index = indexStr.replace("]", "");

      if (!current[arrayName]) return [];

      if (index === "*") {
        const results: string[] = [];
        for (const item of current[arrayName]) {
          if (typeof item === "string") results.push(item);
        }
        return results;
      }

      const idx = parseInt(index, 10);
      if (Number.isNaN(idx)) return [];
      current = current[arrayName][idx];
    } else {
      current = current[part];
    }

    if (current === undefined) return [];
  }

  return typeof current === "string" ? [current] : [];
}

/**
 * Tokenizes a JSON path into parts
 */
export function tokenizePath(path: string): string[] {
  return path.split(".");
}

/**
 * Abstract base class for persistent key-value stores.
 *
 * Stores enable persistence and memory that can be shared across threads,
 * scoped to user IDs, assistant IDs, or other arbitrary namespaces.
 *
 * Features:
 * - Hierarchical namespaces for organization
 * - Key-value storage with metadata
 * - Vector similarity search (if configured)
 * - Filtering and pagination
 */
export abstract class BaseStore {
  /**
   * Execute multiple operations in a single batch.
   * This is more efficient than executing operations individually.
   *
   * @param operations Array of operations to execute
   * @returns Promise resolving to results matching the operations
   */
  abstract batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>>;

  /**
   * Retrieve a single item by its namespace and key.
   *
   * @param namespace Hierarchical path for the item
   * @param key Unique identifier within the namespace
   * @returns Promise resolving to the item or null if not found
   */
  async get(namespace: string[], key: string): Promise<Item | null> {
    return (await this.batch<[GetOperation]>([{ namespace, key }]))[0];
  }

  /**
   * Search for items within a namespace prefix.
   * Supports both metadata filtering and vector similarity search.
   *
   * @param namespacePrefix Hierarchical path prefix to search within
   * @param options Search options for filtering and pagination
   * @returns Promise resolving to list of matching items with relevance scores
   *
   * @example
   * // Search with filters
   * await store.search(["documents"], {
   *   filter: { type: "report", status: "active" },
   *   limit: 5,
   *   offset: 10
   * });
   *
   * // Vector similarity search
   * await store.search(["users", "content"], {
   *   query: "technical documentation about APIs",
   *   limit: 20
   * });
   */
  async search(
    namespacePrefix: string[],
    options: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
      query?: string;
    } = {}
  ): Promise<SearchItem[]> {
    const { filter, limit = 10, offset = 0, query } = options;
    return (
      await this.batch<[SearchOperation]>([
        {
          namespacePrefix,
          filter,
          limit,
          offset,
          query,
        },
      ])
    )[0];
  }

  /**
   * Store or update an item.
   *
   * @param namespace Hierarchical path for the item
   * @param key Unique identifier within the namespace
   * @param value Object containing the item's data
   * @param index Optional indexing configuration
   *
   * @example
   * // Simple storage
   * await store.put(["docs"], "report", { title: "Annual Report" });
   *
   * // With specific field indexing
   * await store.put(
   *   ["docs"],
   *   "report",
   *   {
   *     title: "Q4 Report",
   *     chapters: [{ content: "..." }, { content: "..." }]
   *   },
   *   ["title", "chapters[*].content"]
   * );
   */
  async put(
    namespace: string[],
    key: string,
    value: Record<string, any>,
    index?: false | string[]
  ): Promise<void> {
    validateNamespace(namespace);
    await this.batch<[PutOperation]>([{ namespace, key, value, index }]);
  }

  /**
   * Delete an item from the store.
   *
   * @param namespace Hierarchical path for the item
   * @param key Unique identifier within the namespace
   */
  async delete(namespace: string[], key: string): Promise<void> {
    await this.batch<[PutOperation]>([{ namespace, key, value: null }]);
  }

  /**
   * List and filter namespaces in the store.
   * Used to explore data organization and navigate the namespace hierarchy.
   *
   * @param options Options for listing namespaces
   * @returns Promise resolving to list of namespace paths
   *
   * @example
   * // List all namespaces under "documents"
   * await store.listNamespaces({
   *   prefix: ["documents"],
   *   maxDepth: 2
   * });
   *
   * // List namespaces ending with "v1"
   * await store.listNamespaces({
   *   suffix: ["v1"],
   *   limit: 50
   * });
   */
  async listNamespaces(
    options: {
      prefix?: string[];
      suffix?: string[];
      maxDepth?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<string[][]> {
    const { prefix, suffix, maxDepth, limit = 100, offset = 0 } = options;

    const matchConditions: MatchCondition[] = [];
    if (prefix) {
      matchConditions.push({ matchType: "prefix", path: prefix });
    }
    if (suffix) {
      matchConditions.push({ matchType: "suffix", path: suffix });
    }

    return (
      await this.batch<[ListNamespacesOperation]>([
        {
          matchConditions: matchConditions.length ? matchConditions : undefined,
          maxDepth,
          limit,
          offset,
        },
      ])
    )[0];
  }

  /**
   * Start the store. Override if initialization is needed.
   */
  start(): void | Promise<void> {}

  /**
   * Stop the store. Override if cleanup is needed.
   */
  stop(): void | Promise<void> {}
}
