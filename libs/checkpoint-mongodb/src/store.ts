import { MongoClient, type Db as MongoDatabase } from "mongodb";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
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
 * Computes the namespace path prefixes for denormalization.
 * E.g., ["a", "b", "c"] → ["a", "a/b", "a/b/c"]
 *
 * Stored on each document as `namespacePath` to enable prefix filtering
 * in $vectorSearch, which does not support $expr or $slice.
 * MongoDB array equality matches if any element equals the filter value,
 * so filtering by "a/b" matches any document whose namespace starts with ["a", "b"].
 */
function computeNamespacePath(namespace: string[]): string[] {
  const paths: string[] = [];
  for (let i = 1; i <= namespace.length; i++) {
    paths.push(namespace.slice(0, i).join("/"));
  }
  return paths;
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
 * Configuration for MongoDB vector search index.
 *
 * Two modes depending on whether `embeddings` is provided on the store:
 *
 * **Manual embedding** — `embeddings` is set on MongoDBStoreParams.
 *   The store computes vectors via embedDocuments() / embedQuery() and stores
 *   float arrays in the `embedding` field. Requires `dims` and `similarityFunction`.
 *
 * **Auto embedding** — no `embeddings` on MongoDBStoreParams.
 *   MongoDB generates embeddings server-side via Voyage AI using the configured `model`.
 *   The store does not write an embedding field — MongoDB reads the source text directly
 *   from the field specified by `path` (e.g. "value.content"). Requires `model` and `path`.
 */
export type IndexConfig = {
  /** Vector search index name */
  name: string;
  /**
   * Embedding dimensionality. Required for manual embedding so that the
   * vector search index can be created with the correct number of dimensions.
   * Not required for auto embedding, where the model determines dimensionality.
   */
  dims?: number;
  /** Similarity function (default: "cosine"). Required for manual embedding. */
  similarityFunction?: "cosine" | "euclidean" | "dotProduct";
  /**
   * Sub-field of value to embed (e.g. "content"). If omitted, the entire
   * value object is serialized and embedded.
   */
  embeddingKey?: string;
  /**
   * Field path used in the $vectorSearch stage and vector search index definition.
   * - For manual embedding: the field where the store writes computed vectors.
   *   Defaults to "embedding".
   * - For auto embedding: the field containing the source text that MongoDB
   *   will embed server-side (e.g. "value.content"). Required for auto embedding.
   */
  path?: string;
  /**
   * Voyage AI model name for auto embedding (e.g. "voyage-4", "voyage-4-lite",
   * "voyage-4-large", "voyage-code-3"). Required for auto embedding.
   * MongoDB uses this model to generate embeddings server-side.
   */
  model?: string;
  /** Modality for auto embedding (default: "text"). */
  modality?: string;
  /** Additional filter fields to declare in the vector search index. */
  filters?: string[];
};

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
  embeddings?: EmbeddingsInterface;
  indexConfig?: IndexConfig;
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
  protected embeddings?: EmbeddingsInterface;
  protected indexConfig?: IndexConfig;
  protected ownsClient = false;

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
    embeddings,
    indexConfig,
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
    this.embeddings = embeddings;
    this.indexConfig = indexConfig;
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
    const client = new MongoClient(connString);
    await client.connect();
    const store = new MongoDBStore({ ...params, client });
    store.ownsClient = true;
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

      // Manual embedding: collect texts and compute vectors client-side.
      // Auto embedding: nothing to do here — MongoDB reads the text directly
      // from the field specified by indexConfig.path (e.g. "value.content")
      // and generates embeddings server-side.
      const embeddingByOpIndex = new Map<number, number[]>();

      if (this.indexConfig && this.embeddings) {
        const textsToEmbed: { opIndex: number; text: string }[] = [];

        for (let i = 0; i < opsList.length; i++) {
          const { op } = opsList[i];
          if (op.value === null || op.index === false) continue;

          let text: string;
          if (Array.isArray(op.index)) {
            // Per-operation override: embed only specified fields
            const fields: Record<string, any> = {};
            for (const field of op.index) {
              fields[field] = op.value?.[field];
            }
            text = JSON.stringify(fields);
          } else if (this.indexConfig!.embeddingKey) {
            // Store-level config: embed a specific sub-field of value
            text = JSON.stringify(op.value?.[this.indexConfig!.embeddingKey]);
          } else {
            // Default: embed the entire value
            text = JSON.stringify(op.value);
          }

          textsToEmbed.push({ opIndex: i, text });
        }

        if (textsToEmbed.length > 0) {
          const vectors = await this.embeddings.embedDocuments(
            textsToEmbed.map((t) => t.text)
          );
          for (let j = 0; j < textsToEmbed.length; j++) {
            embeddingByOpIndex.set(textsToEmbed[j].opIndex, vectors[j]);
          }
        }
      }

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
          namespaceStr: namespace.join("/"),
          key,
          value, // Store JSON directly
          updatedAt: now,
        };

        // Add namespacePath for $vectorSearch prefix filtering
        if (this.indexConfig) {
          doc.namespacePath = computeNamespacePath(namespace);
        }

        // Set expiration time if TTL is configured
        if (this.ttl) {
          doc.expiresAt = new Date(now.getTime() + this.ttl.defaultTtl * 1000);
        }

        // Add embedding vector for manual mode.
        // In auto mode, MongoDB reads the text directly from the document
        // (at the path configured in the vector search index), so no
        // separate embedding field is needed.
        const embeddingVector = embeddingByOpIndex.get(i);
        if (embeddingVector !== undefined) {
          const embeddingField = this.indexConfig!.path ?? "embedding";
          doc[embeddingField] = embeddingVector;
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

    if (query) {
      if (!this.indexConfig) {
        throw new Error(
          "Vector search (query parameter) requires indexConfig to be configured."
        );
      }
      return this.vectorSearch(query, namespacePrefix, limit, offset);
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
   * Perform vector similarity search using MongoDB $vectorSearch.
   *
   * Manual mode (embeddings configured): computes query vector via embedQuery(),
   * sends as queryVector to $vectorSearch.
   *
   * Auto mode (no embeddings): sends the query text directly via query.text,
   * MongoDB generates the query embedding server-side.
   */
  private async vectorSearch(
    query: string,
    namespacePrefix: string[],
    limit: number,
    offset: number
  ): Promise<SearchItem[]> {
    const path = this.indexConfig!.path ?? "embedding";
    const vectorSearchStage: Record<string, any> = {
      $vectorSearch: {
        index: this.indexConfig!.name,
        path,
        // numCandidates should be 10-20x limit for good recall, capped at 10000.
        // See: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/#fields
        numCandidates: Math.min((limit + offset) * 20, 10000),
        limit: limit + offset,
      },
    };

    if (this.embeddings) {
      // Manual: compute query vector client-side
      vectorSearchStage.$vectorSearch.queryVector =
        await this.embeddings.embedQuery(query);
    } else {
      // Auto: send query text, MongoDB embeds it server-side
      vectorSearchStage.$vectorSearch.query = { text: query };
    }

    // Namespace prefix filter for $vectorSearch
    if (namespacePrefix.length > 0) {
      vectorSearchStage.$vectorSearch.filter = {
        namespacePath: namespacePrefix.join("/"),
      };
    }

    const pipeline: Record<string, any>[] = [
      vectorSearchStage,
      { $addFields: { score: { $meta: "vectorSearchScore" } } },
    ];

    // Strip the embedding field from manual mode results (vectors can be large)
    if (this.embeddings) {
      pipeline.push({ $project: { [path]: 0 } });
    }

    if (offset > 0) {
      pipeline.push({ $skip: offset });
    }
    pipeline.push({ $limit: limit });

    const docs = await this.db
      .collection(this.collectionName)
      .aggregate(pipeline)
      .toArray();

    return docs.map((doc) => ({
      value: doc.value,
      key: doc.key,
      namespace: doc.namespace,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      score: doc.score,
    }));
  }

  /**
   * Initialize the store: creates the {namespace, key} unique index and an optional
   * TTL index.
   */
  async start(): Promise<void> {
    const collection = this.db.collection(this.collectionName);

    // Use a unique index on the joined namespace string + key, not on the
    // namespace array directly. MongoDB multikey indexes on arrays index each
    // element separately, so two documents with different namespaces that share
    // a common element and the same key would collide (e.g. ["users", "alice",
    // "preferences"] and ["users", "bob", "preferences"] both with key "food").
    await collection.createIndex({ namespaceStr: 1, key: 1 }, { unique: true });

    if (this.ttl) {
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }

    if (this.indexConfig) {
      const fields: Record<string, any>[] = [];
      const path = this.indexConfig.path ?? "embedding";

      if (this.embeddings) {
        // Manual: standard vector field
        fields.push({
          type: "vector",
          path,
          numDimensions: this.indexConfig.dims,
          similarity: this.indexConfig.similarityFunction ?? "cosine",
        });
      } else {
        // Auto: MongoDB embeds the text server-side
        fields.push({
          type: "autoEmbed",
          path,
          model: this.indexConfig.model,
          modality: this.indexConfig.modality ?? "text",
        });
      }

      // Always include namespacePath for $vectorSearch pre-filtering
      fields.push({ type: "filter", path: "namespacePath" });

      for (const filterField of this.indexConfig.filters ?? []) {
        fields.push({ type: "filter", path: filterField });
      }

      // The vector search index is built asynchronously by Atlas. createSearchIndex
      // returns as soon as the build is scheduled — it does NOT wait for the index
      // to become queryable. Writes (put/delete) work immediately, but vector
      // search queries (search with `query`) will fail until the index reaches
      // READY status, which can take seconds to minutes. If you need to gate
      // application traffic on index readiness, poll `collection.listSearchIndexes`
      // for `status === "READY"` before issuing vector searches.
      try {
        await collection.createSearchIndex({
          name: this.indexConfig.name,
          type: "vectorSearch",
          definition: { fields },
        } as any);
      } catch (err: any) {
        if (!err?.message?.toLowerCase().includes("already exists")) {
          throw err;
        }
      }
    }
  }

  /**
   * Clean up the store. Closes the underlying MongoClient only if the store
   * created it (i.e. via {@link fromConnString}). When the client was supplied
   * to the constructor by the caller, the caller owns its lifecycle.
   */
  async stop(): Promise<void> {
    if (this.ownsClient) {
      await this.client.close();
    }
  }
}
