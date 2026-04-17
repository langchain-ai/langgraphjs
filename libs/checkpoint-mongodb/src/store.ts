import { type MongoClient, type Db as MongoDatabase } from "mongodb";
import {
  BaseStore,
  type Operation,
  type OperationResults,
  type Item,
  type PutOperation,
  type GetOperation,
  type ListNamespacesOperation,
  type SearchOperation,
  type SearchItem,
  InvalidNamespaceError,
} from "@langchain/langgraph-checkpoint";

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
 * Time-to-live configuration for automatic document expiration.
 *
 * Uses a MongoDB TTL index on the `expiresAt` field. Each document's
 * `expiresAt` is set to `now + defaultTtl` on every put (and optionally
 * on every get when `refreshOnRead` is true). MongoDB's background thread
 * automatically removes documents once `expiresAt` has passed.
 *
 * Requires {@link MongoDBStore.start} to be called to create the TTL index.
 */
export type TTLConfig = {
  /** Default TTL in seconds */
  defaultTtl: number;
  /** Whether to reset TTL timer on get (extends life of frequently accessed items) */
  refreshOnRead: boolean;
};

export type MongoDBStoreParams = {
  client: MongoClient;
  dbName?: string;
  collectionName?: string;
  enableTimestamps?: boolean;
  ttl?: TTLConfig;
};

/**
 * A long-term persistent key-value store backed by MongoDB.
 * Supports hierarchical namespace organization with Put, Get, ListNamespaces, and Search operations.
 */
export class MongoDBStore extends BaseStore {
  protected client: MongoClient;
  protected db: MongoDatabase;
  protected collectionName: string;
  protected enableTimestamps: boolean;
  protected ttl?: TTLConfig;

  private get timestampOp() {
    return this.enableTimestamps
      ? ({ $currentDate: { upserted_at: true } } as const)
      : {};
  }

  constructor({
    client,
    dbName,
    collectionName = "store",
    enableTimestamps,
    ttl,
  }: MongoDBStoreParams) {
    super();
    this.client = client;
    this.client.appendMetadata({
      name: "langgraphjs_store",
    });
    this.db = this.client.db(dbName);
    this.collectionName = collectionName;
    this.enableTimestamps = enableTimestamps ?? false;
    this.ttl = ttl;
  }

  /**
   * Factory method to create a MongoDBStore from a connection string.
   * Automatically creates and connects a MongoDB client, and calls
   * {@link start} to ensure required indexes exist.
   * @param connString MongoDB connection string
   * @param params Store configuration
   */
  static async fromConnString(
    connString: string,
    params?: Omit<MongoDBStoreParams, "client">
  ): Promise<MongoDBStore> {
    const { MongoClient: MC } = await import("mongodb");
    const client = new MC(connString);
    await client.connect();
    const store = new MongoDBStore({ ...params, client });
    await store.start();
    return store;
  }

  /**
   * Execute a batch of operations (Put, Get, ListNamespaces, Search).
   * Operations are processed in order, but multiple consecutive Puts are batched.
   * PutOperations are deduplicated by (namespace, key) — last write wins.
   */
  async batch<Op extends readonly Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results: unknown[] = new Array(operations.length);

    // Process operations in order, batching consecutive Puts
    let i = 0;
    while (i < operations.length) {
      const op = operations[i];

      // If it's a Put, collect all consecutive Puts
      if ("value" in op) {
        const putIndices: number[] = [i];
        let j = i + 1;
        while (j < operations.length && "value" in operations[j]) {
          putIndices.push(j);
          j++;
        }

        // Execute batched Puts
        await this.batchPuts(
          putIndices.map((idx) => ({
            index: idx,
            op: operations[idx] as PutOperation,
          })),
          results
        );

        i = j;
      } else {
        // Process single read operation
        const readOp = op;
        if ("key" in readOp && !("namespacePrefix" in readOp)) {
          results[i] = await this.getOp(readOp as GetOperation);
        } else if ("namespacePrefix" in readOp) {
          results[i] = await this.searchOp(readOp as SearchOperation);
        } else {
          results[i] = await this.listNamespacesOp(
            readOp as ListNamespacesOperation
          );
        }
        i++;
      }
    }

    return results as OperationResults<Op>;
  }

  /**
   * Execute a batch of Put operations with deduplication.
   */
  private async batchPuts(
    putOpsWithIndex: Array<{ index: number; op: PutOperation }>,
    results: unknown[]
  ): Promise<void> {
    // Deduplicate put operations by (namespace, key) — last write wins
    const deduped = new Map<string, { index: number; op: PutOperation }>();
    for (const { index, op } of putOpsWithIndex) {
      const key = JSON.stringify({ namespace: op.namespace, key: op.key });
      deduped.set(key, { index, op });
    }

    // Prepare bulk write operations
    if (deduped.size > 0) {
      const bulkOps: any[] = [];
      const opsList = Array.from(deduped.values());

      // Build bulk write operations
      for (let i = 0; i < opsList.length; i++) {
        const { op } = opsList[i];
        const { namespace, key, value } = op;

        // Validate namespace
        validateNamespace(namespace);

        // Handle delete
        if (value === null) {
          bulkOps.push({
            deleteOne: {
              filter: { namespace, key },
            },
          });
          continue;
        }

        // Build document
        const now = new Date();
        const doc: Record<string, any> = {
          namespace,
          key,
          value, // Store JSON directly
          updatedAt: now,
        };

        // Set expiration time if TTL is configured
        if (this.ttl) {
          doc.expiresAt = new Date(now.getTime() + this.ttl.defaultTtl * 1000);
        }

        bulkOps.push({
          updateOne: {
            filter: { namespace, key },
            update: {
              $set: doc,
              $setOnInsert: { createdAt: now },
              ...this.timestampOp,
            },
            upsert: true,
          },
        });
      }

      // Execute bulk write
      if (bulkOps.length > 0) {
        await this.db.collection(this.collectionName).bulkWrite(bulkOps);
      }

      // Fill results for put operations (all are undefined)
      for (const { index } of putOpsWithIndex) {
        results[index] = undefined;
      }
    }
  }

  /**
   * Retrieve an item by namespace and key.
   * If refreshOnRead is enabled, resets the TTL timer.
   */
  private async getOp(op: GetOperation): Promise<Item | null> {
    const { namespace, key } = op;

    let doc;
    if (this.ttl?.refreshOnRead) {
      // Use findOneAndUpdate to refresh the TTL timer
      const now = new Date();
      const updateDoc: Record<string, any> = { updatedAt: now };
      if (this.ttl) {
        updateDoc.expiresAt = new Date(
          now.getTime() + this.ttl.defaultTtl * 1000
        );
      }
      doc = await this.db
        .collection(this.collectionName)
        .findOneAndUpdate(
          { namespace, key },
          { $set: updateDoc },
          { returnDocument: "after" }
        );
    } else {
      doc = await this.db
        .collection(this.collectionName)
        .findOne({ namespace, key });
    }

    if (!doc) {
      return null;
    }

    return {
      value: doc.value,
      key: doc.key,
      namespace: doc.namespace,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  /**
   * List namespaces in the store, filtered by matchConditions (prefix/suffix with wildcards).
   *
   * Called by BaseStore.listNamespaces() which converts user-facing prefix/suffix
   * options into MatchCondition objects. Each MatchCondition specifies:
   *   - matchType: "prefix" (match from start) or "suffix" (match from end)
   *   - path: array of labels, where "*" is a wildcard matching any value
   *
   * All conditions must be satisfied (AND logic).
   *
   * Uses $expr with $arrayElemAt for positional element matching because
   * wildcards and suffix matching require skipping positions or indexing
   * from the end, which dot-notation cannot express.
   */
  private async listNamespacesOp(
    op: ListNamespacesOperation
  ): Promise<string[][]> {
    const { matchConditions, maxDepth, limit, offset } = op;

    const pipeline: Record<string, any>[] = [];

    // Stage 1: Build $match from matchConditions.
    if (matchConditions && matchConditions.length > 0) {
      const conditions: Record<string, any>[] = [];

      for (const condition of matchConditions) {
        const { matchType, path } = condition;

        if (matchType === "prefix") {
          // Match each non-wildcard element from the start of the namespace.
          // E.g. prefix ["users", "*", "settings"] becomes:
          //   namespace[0] == "users" AND namespace[2] == "settings"
          //   AND namespace.length >= 3
          // (index 1 is skipped because it's a wildcard)
          const elemConditions: Record<string, any>[] = [];
          for (let i = 0; i < path.length; i++) {
            if (path[i] !== "*") {
              elemConditions.push({
                $eq: [{ $arrayElemAt: ["$namespace", i] }, path[i]],
              });
            }
          }
          elemConditions.push({
            $gte: [{ $size: "$namespace" }, path.length],
          });
          conditions.push({ $and: elemConditions });
        } else if (matchType === "suffix") {
          // Match each non-wildcard element from the end of the namespace.
          // E.g. suffix ["v1"] becomes: namespace[-1] == "v1"
          //   AND namespace.length >= 1
          // Negative $arrayElemAt indices count from the end.
          const elemConditions: Record<string, any>[] = [];
          for (let i = 0; i < path.length; i++) {
            if (path[i] !== "*") {
              elemConditions.push({
                $eq: [
                  { $arrayElemAt: ["$namespace", -(path.length - i)] },
                  path[i],
                ],
              });
            }
          }
          elemConditions.push({
            $gte: [{ $size: "$namespace" }, path.length],
          });
          conditions.push({ $and: elemConditions });
        }
      }

      if (conditions.length > 0) {
        pipeline.push({
          $match: {
            $expr:
              conditions.length === 1 ? conditions[0] : { $and: conditions },
          },
        });
      }
    }

    // Stage 2: Group to get unique namespaces
    pipeline.push({
      $group: { _id: "$namespace" },
    });

    // Stage 3: Filter by max depth if provided
    if (maxDepth !== undefined) {
      pipeline.push({
        $match: {
          $expr: {
            $lte: [{ $size: "$_id" }, maxDepth],
          },
        },
      });
    }

    // Stage 4: Sort by namespace
    pipeline.push({
      $sort: { _id: 1 },
    });

    // Stage 5: Apply offset and limit
    if (offset !== undefined && offset > 0) {
      pipeline.push({ $skip: offset });
    }
    pipeline.push({ $limit: limit ?? 100 });

    const docs = await this.db
      .collection(this.collectionName)
      .aggregate(pipeline)
      .toArray();

    return docs.map((doc) => doc._id);
  }

  /**
   * Search for items by namespace prefix and filter criteria.
   * Supports field-based filtering (structured search) on value fields.
   */
  private async searchOp(op: SearchOperation): Promise<SearchItem[]> {
    const {
      namespacePrefix,
      filter,
      limit = 100,
      offset = 0,
      query,
    } = op as SearchOperation & { query?: string };

    // Vector search is not supported without embedding configuration
    if (query) {
      throw new Error(
        "Vector search (query parameter) requires embedding support, " +
          "which is not configured. Use field-based filtering (filter parameter) instead."
      );
    }

    // Perform structured field-based search
    // Build MongoDB query for namespace and field filtering
    const mongoQuery: Record<string, any> = {};

    // Filter by namespace prefix using dot-notation array indexing.
    // E.g. namespacePrefix ["users", "profiles"] becomes:
    //   { "namespace.0": "users", "namespace.1": "profiles" }
    // This matches ["users", "profiles"] and any nested namespaces like
    // ["users", "profiles", "settings"], but not ["users"] alone.
    if (namespacePrefix && namespacePrefix.length > 0) {
      for (let idx = 0; idx < namespacePrefix.length; idx++) {
        mongoQuery[`namespace.${idx}`] = namespacePrefix[idx];
      }
    }

    // Build filter conditions against the stored value document
    if (filter && Object.keys(filter).length > 0) {
      for (const [field, condition] of Object.entries(filter)) {
        if (
          typeof condition === "object" &&
          condition !== null &&
          !Array.isArray(condition)
        ) {
          // Handle advanced operators
          for (const [operator, operatorValue] of Object.entries(condition)) {
            switch (operator) {
              case "$eq":
                mongoQuery[`value.${field}`] = operatorValue;
                break;
              case "$ne":
                mongoQuery[`value.${field}`] = { $ne: operatorValue };
                break;
              case "$gt":
                mongoQuery[`value.${field}`] = { $gt: operatorValue };
                break;
              case "$gte":
                mongoQuery[`value.${field}`] = { $gte: operatorValue };
                break;
              case "$lt":
                mongoQuery[`value.${field}`] = { $lt: operatorValue };
                break;
              case "$lte":
                mongoQuery[`value.${field}`] = { $lte: operatorValue };
                break;
            }
          }
        } else {
          // Exact match
          mongoQuery[`value.${field}`] = condition;
        }
      }
    }

    // Execute query with limit and offset
    const docs = await this.db
      .collection(this.collectionName)
      .find(mongoQuery)
      .skip(offset)
      .limit(limit)
      .toArray();

    // Deserialize only the matched documents
    const items: SearchItem[] = [];
    for (const doc of docs) {
      items.push({
        value: doc.value,
        key: doc.key,
        namespace: doc.namespace,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      });
    }

    return items;
  }

  /**
   * Initialize the store: creates the {namespace, key} unique index and an optional
   * TTL index.
   */
  async start(): Promise<void> {
    const collection = this.db.collection(this.collectionName);

    await collection.createIndex({ namespace: 1, key: 1 }, { unique: true });

    if (this.ttl) {
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }
  }

  /**
   * Clean up the store (no-op for now).
   */
  async stop(): Promise<void> {
    // No-op
  }
}
