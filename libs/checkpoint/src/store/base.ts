/**
 * Represents a stored item with metadata.
 */
export interface Item {
  /**
   * The stored data as an object. Keys are filterable.
   */
  value: Record<string, any>;
  /**
   * Relevance scores for the item.
   * Keys can include built-in scores like 'recency' and 'relevance',
   * as well as any key present in the 'value' object. This allows
   * for multi-dimensional scoring of items.
   */
  scores: Record<string, number>;
  /**
   * Unique identifier within the namespace.
   */
  id: string;
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
  /**
   * Timestamp of last access.
   */
  lastAccessedAt: Date;
}

/**
 * Operation to retrieve an item by namespace and ID.
 */
export interface GetOperation {
  /**
   * Hierarchical path for the item.
   */
  namespace: string[];
  /**
   * Unique identifier within the namespace.
   */
  id: string;
}

/**
 * Operation to search for items within a namespace prefix.
 */
export interface SearchOperation {
  /**
   * Hierarchical path prefix to search within.
   */
  namespacePrefix: string[];
  /**
   * Key-value pairs to filter results.
   */
  filter?: Record<string, any>;
  /**
   * Maximum number of items to return.
   * @default 10
   */
  limit?: number;
  /**
   * Number of items to skip before returning results.
   * @default 0
   */
  offset?: number;
}

/**
 * Operation to store, update, or delete an item.
 */
export interface PutOperation {
  /**
   * Hierarchical path for the item.
   * Represented as a tuple of strings, allowing for nested categorization.
   * @example ["documents", "user123"]
   */
  namespace: string[];
  /**
   * Unique identifier for the document.
   * Should be distinct within its namespace.
   */
  id: string;
  /**
   * Data to be stored, or None to delete the item.
   * Schema:
   *  - Should be an object where:
   *    - Keys are strings representing field names
   *    - Values can be of any serializable type
   *  - If null, it indicates that the item should be deleted
   */
  value: Record<string, any> | null;
}

export type Operation = GetOperation | SearchOperation | PutOperation;

export type OperationResults<Tuple extends readonly Operation[]> = {
  [K in keyof Tuple]: Tuple[K] extends PutOperation
    ? void
    : Tuple[K] extends SearchOperation
    ? Item[]
    : Tuple[K] extends GetOperation
    ? Item | null
    : never;
};

/**
 * Abstract base class for key-value stores.
 */
export abstract class BaseStore {
  /**
   * Execute a batch of operations.
   * @param _operations An array of operations to execute.
   * @returns A promise that resolves to the results of the operations.
   */
  async batch<Op extends Operation[]>(
    _operations: Op
  ): Promise<OperationResults<Op>> {
    throw new Error("Method not implemented.");
  }

  // convenience methods

  /**
   * Retrieve a single item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   * @returns A promise that resolves to the retrieved item or null if not found.
   */
  async get(namespace: string[], id: string): Promise<Item | null> {
    const batchResult = await this.batch<[GetOperation]>([{ namespace, id }]);
    return batchResult[0];
  }

  /**
   * Search for items within a namespace prefix.
   * @param namespacePrefix Hierarchical path prefix to search within.
   * @param options Search options.
   * @param options.filter Key-value pairs to filter results.
   * @param options.limit Maximum number of items to return (default: 10).
   * @param options.offset Number of items to skip before returning results (default: 0).
   * @returns A promise that resolves to a list of items matching the search criteria.
   */
  async search(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
    }
  ): Promise<Item[]> {
    const optionsWithDefaults = {
      limit: 10,
      offset: 0,
      ...(options || {}),
    };
    const batchResults = await this.batch<[SearchOperation]>([
      { namespacePrefix, ...optionsWithDefaults },
    ]);
    return batchResults[0];
  }

  /**
   * Store or update an item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   * @param value Object containing the item's data.
   */
  async put(
    namespace: string[],
    id: string,
    value: Record<string, any>
  ): Promise<void> {
    await this.batch<[PutOperation]>([{ namespace, id, value }]);
  }

  /**
   * Delete an item.
   * @param namespace Hierarchical path for the item.
   * @param id Unique identifier within the namespace.
   */
  async delete(namespace: string[], id: string): Promise<void> {
    await this.batch<[PutOperation]>([{ namespace, id, value: null }]);
  }

  /**
   * Stop the store. No-op if not implemented.
   */
  stop(): void {
    // no-op if not implemented.
  }

  /**
   * Start the store. No-op if not implemented.
   */
  start(): void {
    // no-op if not implemented.
  }
}
