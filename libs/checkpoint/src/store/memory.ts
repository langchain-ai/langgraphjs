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
        results.push(this.getOperation(op));
      } else if ("namespacePrefix" in op) {
        // SearchOperation
        results.push(this.searchOperation(op));
      } else if ("value" in op) {
        // PutOperation
        results.push(this.putOperation(op));
      } else if ("matchConditions" in op) {
        // ListNamespacesOperation
        results.push(this.listNamespacesOperation(op));
      }
    }

    return Promise.resolve(results) as OperationResults<Op>;
  }

  private getOperation(op: GetOperation): Item | null {
    const namespaceKey = op.namespace.join(":");
    const item = this.data.get(namespaceKey)?.get(op.id);
    return item || null;
  }

  private searchOperation(op: SearchOperation): Item[] {
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
    return searchResults;
  }

  private putOperation(op: PutOperation): void {
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
          id: op.id,
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

    const paginatedNamespaces = namespaces.slice(
      op.offset,
      op.offset + op.limit
    );

    return paginatedNamespaces;
  }

  private doesMatch(matchCondition: MatchCondition, key: string[]): boolean {
    const { matchType, path } = matchCondition;

    if (key.length < path.length) {
      return false;
    }

    if (matchType === "prefix") {
      return path.every((pElem, index) => {
        const kElem = key[index];
        return pElem === "*" || kElem === pElem;
      });
    } else if (matchType === "suffix") {
      return [...path].reverse().every((pElem, index) => {
        const kElem = key[key.length - 1 - index];
        return pElem === "*" || kElem === pElem;
      });
    }

    throw new Error(`Unsupported match type: ${matchType}`);
  }
}
