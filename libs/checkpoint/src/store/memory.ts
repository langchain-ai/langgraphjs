import {
  BaseStore,
  type OperationResults,
  type Item,
  type Operation,
} from "./base.js";

export class MemoryStore extends BaseStore {
  private data: Map<string, Map<string, Item>> = new Map();

  async batch<Op extends Operation[]>(
    operations: Op
  ): Promise<OperationResults<Op>> {
    const results = [];

    for (const op of operations) {
      if ("id" in op && "namespace" in op && !("value" in op)) {
        // GetOperation
        const namespaceKey = op.namespace.join(":");
        const item = this.data.get(namespaceKey)?.get(op.id);
        if (item) {
          item.lastAccessedAt = new Date();
        }
        results.push(item || null);
      } else if ("namespacePrefix" in op) {
        // SearchOperation
        const candidates: Item[] = [];
        for (const [namespace, items] of this.data.entries()) {
          if (namespace.startsWith(op.namespacePrefix.join(":"))) {
            candidates.push(...items.values());
          }
        }

        let filteredCandidates = candidates;
        if (op.filter) {
          filteredCandidates = candidates.filter((item) =>
            Object.entries(op.filter!).every(
              ([key, value]) => item.value[key] === value
            )
          );
        }
        const searchResults = filteredCandidates.slice(
          op.offset || 0,
          (op.offset || 0) + (op.limit || 10)
        );
        results.push(searchResults);
      } else if ("value" in op) {
        // PutOperation
        const namespaceKey = op.namespace.join(":");
        if (!this.data.has(namespaceKey)) {
          this.data.set(namespaceKey, new Map());
        }
        const namespaceMap = this.data.get(namespaceKey)!;

        if (op.value === null) {
          namespaceMap.delete(op.id);
        } else {
          const now = new Date();
          if (namespaceMap.has(op.id)) {
            const item = namespaceMap.get(op.id)!;
            item.value = op.value;
            item.updatedAt = now;
          } else {
            namespaceMap.set(op.id, {
              value: op.value,
              scores: {},
              id: op.id,
              namespace: op.namespace,
              createdAt: now,
              updatedAt: now,
              lastAccessedAt: now,
            });
          }
        }
        results.push(undefined);
      }
    }

    return Promise.resolve(results) as OperationResults<Op>;
  }
}
