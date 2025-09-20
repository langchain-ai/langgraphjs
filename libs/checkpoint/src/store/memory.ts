import {
  BaseStore,
  type OperationResults,
  type Item,
  type Operation,
  MatchCondition,
  ListNamespacesOperation,
  PutOperation,
  SearchOperation,
  GetOperation,
  type IndexConfig,
  type SearchItem,
} from "./base.js";
import { tokenizePath, compareValues, getTextAtPath } from "./utils.js";

/**
 * In-memory key-value store with optional vector search.
 *
 * A lightweight store implementation using JavaScript Maps. Supports basic
 * key-value operations and vector search when configured with embeddings.
 *
 * @example
 * ```typescript
 * // Basic key-value storage
 * const store = new InMemoryStore();
 * await store.put(["users", "123"], "prefs", { theme: "dark" });
 * const item = await store.get(["users", "123"], "prefs");
 *
 * // Vector search with embeddings
 * import { OpenAIEmbeddings } from "@langchain/openai";
 * const store = new InMemoryStore({
 *   index: {
 *     dims: 1536,
 *     embeddings: new OpenAIEmbeddings({ modelName: "text-embedding-3-small" }),
 *   }
 * });
 *
 * // Store documents
 * await store.put(["docs"], "doc1", { text: "Python tutorial" });
 * await store.put(["docs"], "doc2", { text: "TypeScript guide" });
 *
 * // Search by similarity
 * const results = await store.search(["docs"], { query: "python programming" });
 * ```
 *
 * **Warning**: This store keeps all data in memory. Data is lost when the process exits.
 * For persistence, use a database-backed store.
 */
export class InMemoryStore extends BaseStore {
  private data: Map<string, Map<string, Item>> = new Map();

  // Namespace -> Key -> Path/field -> Vector
  private vectors: Map<string, Map<string, Map<string, number[]>>> = new Map();

  private _indexConfig?: IndexConfig & {
    __tokenizedFields: Array<[string, string[]]>;
  };

  constructor(options?: { index?: IndexConfig }) {
    super();
    if (options?.index) {
      this._indexConfig = {
        ...options.index,
        __tokenizedFields: (options.index.fields ?? ["$"]).map((p) => [
          p,
          p === "$" ? [p] : tokenizePath(p),
        ]),
      };
    }
  }

  async batch<Op extends readonly Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results = [];
    const putOps = new Map<string, PutOperation>();
    const searchOps = new Map<number, [SearchOperation, Item[]]>();

    // First pass - handle gets and prepare search/put operations
    for (let i = 0; i < operations.length; i += 1) {
      const op = operations[i];
      if ("key" in op && "namespace" in op && !("value" in op)) {
        // GetOperation
        results.push(this.getOperation(op));
      } else if ("namespacePrefix" in op) {
        // SearchOperation
        const candidates = this.filterItems(op);
        searchOps.set(i, [op, candidates]);
        results.push(null);
      } else if ("value" in op) {
        // PutOperation
        const key = `${op.namespace.join(":")}:${op.key}`;
        putOps.set(key, op);
        results.push(null);
      } else if ("matchConditions" in op) {
        // ListNamespacesOperation
        results.push(this.listNamespacesOperation(op));
      }
    }

    // Handle search operations with embeddings
    if (searchOps.size > 0) {
      if (this._indexConfig?.embeddings) {
        const queries = new Set<string>();
        for (const [op] of searchOps.values()) {
          if (op.query) queries.add(op.query);
        }

        // Get embeddings for all queries
        const queryEmbeddings =
          queries.size > 0
            ? await Promise.all(
                Array.from(queries).map((q) =>
                  this._indexConfig!.embeddings.embedQuery(q)
                )
              )
            : [];
        const queryVectors = Object.fromEntries(
          Array.from(queries).map((q, i) => [q, queryEmbeddings[i]])
        );

        // Process each search operation
        for (const [i, [op, candidates]] of searchOps.entries()) {
          if (op.query && queryVectors[op.query]) {
            const queryVector = queryVectors[op.query];
            const scoredResults = this.scoreResults(
              candidates,
              queryVector,
              op.offset ?? 0,
              op.limit ?? 10
            );
            results[i] = scoredResults;
          } else {
            results[i] = this.paginateResults(
              candidates.map((item) => ({ ...item, score: undefined })),
              op.offset ?? 0,
              op.limit ?? 10
            );
          }
        }
      } else {
        // No embeddings - just paginate the filtered results
        for (const [i, [op, candidates]] of searchOps.entries()) {
          results[i] = this.paginateResults(
            candidates.map((item) => ({ ...item, score: undefined })),
            op.offset ?? 0,
            op.limit ?? 10
          );
        }
      }
    }

    // Handle put operations with embeddings
    if (putOps.size > 0 && this._indexConfig?.embeddings) {
      const toEmbed = this.extractTexts(Array.from(putOps.values()));
      if (Object.keys(toEmbed).length > 0) {
        const embeddings = await this._indexConfig.embeddings.embedDocuments(
          Object.keys(toEmbed)
        );
        this.insertVectors(toEmbed, embeddings);
      }
    }

    // Apply all put operations
    for (const op of putOps.values()) {
      this.putOperation(op);
    }

    return results as OperationResults<Op>;
  }

  private getOperation(op: GetOperation): Item | null {
    const namespaceKey = op.namespace.join(":");
    const item = this.data.get(namespaceKey)?.get(op.key);
    return item ?? null;
  }

  private putOperation(op: PutOperation): void {
    const namespaceKey = op.namespace.join(":");
    if (!this.data.has(namespaceKey)) {
      this.data.set(namespaceKey, new Map());
    }
    const namespaceMap = this.data.get(namespaceKey)!;

    if (op.value === null) {
      namespaceMap.delete(op.key);
    } else {
      const now = new Date();
      if (namespaceMap.has(op.key)) {
        const item = namespaceMap.get(op.key)!;
        item.value = op.value;
        item.updatedAt = now;
      } else {
        namespaceMap.set(op.key, {
          value: op.value,
          key: op.key,
          namespace: op.namespace,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  private listNamespacesOperation(op: ListNamespacesOperation): string[][] {
    const allNamespaces = Array.from(this.data.keys()).map((ns) =>
      ns.split(":")
    );
    let namespaces = allNamespaces;

    if (op.matchConditions && op.matchConditions.length > 0) {
      namespaces = namespaces.filter((ns) =>
        op.matchConditions!.every((condition) => this.doesMatch(condition, ns))
      );
    }

    if (op.maxDepth !== undefined) {
      namespaces = Array.from(
        new Set(namespaces.map((ns) => ns.slice(0, op.maxDepth).join(":")))
      ).map((ns) => ns.split(":"));
    }

    namespaces.sort((a, b) => a.join(":").localeCompare(b.join(":")));

    return namespaces.slice(
      op.offset ?? 0,
      (op.offset ?? 0) + (op.limit ?? namespaces.length)
    );
  }

  private doesMatch(matchCondition: MatchCondition, key: string[]): boolean {
    const { matchType, path } = matchCondition;

    if (matchType === "prefix") {
      if (path.length > key.length) return false;
      return path.every((pElem, index) => {
        const kElem = key[index];
        return pElem === "*" || kElem === pElem;
      });
    } else if (matchType === "suffix") {
      if (path.length > key.length) return false;
      return path.every((pElem, index) => {
        const kElem = key[key.length - path.length + index];
        return pElem === "*" || kElem === pElem;
      });
    }

    throw new Error(`Unsupported match type: ${matchType}`);
  }

  private filterItems(op: SearchOperation): Item[] {
    const candidates: Item[] = [];
    for (const [namespace, items] of this.data.entries()) {
      if (namespace.startsWith(op.namespacePrefix.join(":"))) {
        candidates.push(...items.values());
      }
    }

    let filteredCandidates = candidates;
    if (op.filter) {
      filteredCandidates = candidates.filter((item) =>
        Object.entries(op.filter!).every(([key, value]) =>
          compareValues(item.value[key], value)
        )
      );
    }
    return filteredCandidates;
  }

  private scoreResults(
    candidates: Item[],
    queryVector: number[],
    offset: number = 0,
    limit: number = 10
  ): SearchItem[] {
    const flatItems: Item[] = [];
    const flatVectors: number[][] = [];
    const scoreless: Item[] = [];

    for (const item of candidates) {
      const vectors = this.getVectors(item);
      if (vectors.length) {
        for (const vector of vectors) {
          flatItems.push(item);
          flatVectors.push(vector);
        }
      } else {
        scoreless.push(item);
      }
    }

    const scores = this.cosineSimilarity(queryVector, flatVectors);

    const sortedResults = scores
      .map((score, i) => [score, flatItems[i]] as [number, Item])
      .sort((a, b) => b[0] - a[0]);

    const seen = new Set<string>();
    const kept: Array<[number | undefined, Item]> = [];

    for (const [score, item] of sortedResults) {
      const key = `${item.namespace.join(":")}:${item.key}`;
      if (seen.has(key)) continue;

      const ix = seen.size;
      if (ix >= offset + limit) break;
      if (ix < offset) {
        seen.add(key);
        continue;
      }

      seen.add(key);
      kept.push([score, item]);
    }

    if (scoreless.length && kept.length < limit) {
      for (const item of scoreless.slice(0, limit - kept.length)) {
        const key = `${item.namespace.join(":")}:${item.key}`;
        if (!seen.has(key)) {
          seen.add(key);
          kept.push([undefined, item]);
        }
      }
    }
    return kept.map(([score, item]) => ({
      ...item,
      score,
    }));
  }

  private paginateResults(
    results: SearchItem[],
    offset: number,
    limit: number
  ): SearchItem[] {
    return results.slice(offset, offset + limit);
  }

  private extractTexts(ops: PutOperation[]): {
    [text: string]: [string[], string, string][];
  } {
    if (!ops.length || !this._indexConfig) {
      return {};
    }

    const toEmbed: { [text: string]: [string[], string, string][] } = {};

    for (const op of ops) {
      if (op.value !== null && op.index !== false) {
        const paths =
          op.index === null || op.index === undefined
            ? this._indexConfig.__tokenizedFields ?? []
            : op.index.map(
                (ix) => [ix, tokenizePath(ix)] as [string, string[]]
              );
        for (const [path, field] of paths) {
          const texts = getTextAtPath(op.value, field);
          if (texts.length) {
            if (texts.length > 1) {
              texts.forEach((text, i) => {
                if (!toEmbed[text]) toEmbed[text] = [];
                toEmbed[text].push([op.namespace, op.key, `${path}.${i}`]);
              });
            } else {
              if (!toEmbed[texts[0]]) toEmbed[texts[0]] = [];
              toEmbed[texts[0]].push([op.namespace, op.key, path]);
            }
          }
        }
      }
    }

    return toEmbed;
  }

  private insertVectors(
    texts: { [text: string]: [string[], string, string][] },
    embeddings: number[][]
  ): void {
    for (const [text, metadata] of Object.entries(texts)) {
      const embedding = embeddings.shift();
      if (!embedding) {
        throw new Error(`No embedding found for text: ${text}`);
      }

      for (const [namespace, key, field] of metadata) {
        const namespaceKey = namespace.join(":");
        if (!this.vectors.has(namespaceKey)) {
          this.vectors.set(namespaceKey, new Map());
        }
        const namespaceMap = this.vectors.get(namespaceKey)!;
        if (!namespaceMap.has(key)) {
          namespaceMap.set(key, new Map());
        }
        const itemMap = namespaceMap.get(key)!;
        itemMap.set(field, embedding);
      }
    }
  }

  private getVectors(item: Item): number[][] {
    const namespaceKey = item.namespace.join(":");
    const itemKey = item.key;
    if (!this.vectors.has(namespaceKey)) {
      return [];
    }
    const namespaceMap = this.vectors.get(namespaceKey)!;
    if (!namespaceMap.has(itemKey)) {
      return [];
    }
    const itemMap = namespaceMap.get(itemKey)!;
    const vectors = Array.from(itemMap.values());
    if (!vectors.length) {
      return [];
    }
    return vectors;
  }

  private cosineSimilarity(X: number[], Y: number[][]): number[] {
    if (!Y.length) return [];

    // Calculate dot products for all vectors at once
    const dotProducts = Y.map((vector) =>
      vector.reduce((acc, val, i) => acc + val * X[i], 0)
    );

    // Calculate magnitudes
    const magnitude1 = Math.sqrt(X.reduce((acc, val) => acc + val * val, 0));
    const magnitudes2 = Y.map((vector) =>
      Math.sqrt(vector.reduce((acc, val) => acc + val * val, 0))
    );

    // Calculate similarities
    return dotProducts.map((dot, i) => {
      const magnitude2 = magnitudes2[i];
      return magnitude1 && magnitude2 ? dot / (magnitude1 * magnitude2) : 0;
    });
  }

  public get indexConfig(): IndexConfig | undefined {
    return this._indexConfig;
  }
}

/** @deprecated Alias for InMemoryStore */
export class MemoryStore extends InMemoryStore {}
