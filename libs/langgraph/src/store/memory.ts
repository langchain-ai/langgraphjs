import { BaseStore, type Values } from "./base.js";

export class MemoryStore extends BaseStore {
  private data: Map<string, Map<string, Values>> = new Map();

  async list(
    prefixes: string[]
  ): Promise<Record<string, Record<string, Values>>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, Record<string, any>> = {};
    for (const prefix of prefixes) {
      if (this.data.has(prefix)) {
        result[prefix] = Object.fromEntries(this.data.get(prefix)!);
      } else {
        result[prefix] = {};
      }
    }
    return Promise.resolve(result);
  }

  async put(writes: Array<[string, string, Values | null]>): Promise<void> {
    for (const [namespace, key, value] of writes) {
      if (!this.data.has(namespace)) {
        this.data.set(namespace, new Map());
      }
      const namespaceMap = this.data.get(namespace)!;
      if (value === null) {
        namespaceMap.delete(key);
      } else {
        namespaceMap.set(key, value);
      }
    }
  }
}
