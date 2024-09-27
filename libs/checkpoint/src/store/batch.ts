import {
  BaseStore,
  type Item,
  type SearchOperation,
  type PutOperation,
  type GetOperation,
  type Operation,
} from "./base.js";

export class AsyncBatchedStore extends BaseStore {
  private store: BaseStore;
  private queue: Map<
    symbol,
    { operation: Operation; resolve: Function; reject: Function }
  > = new Map();
  private running = false;
  private processingTask: Promise<void> | null = null;

  constructor(store: BaseStore) {
    super();
    this.store = store;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async get(namespace: string[], id: string): Promise<Item | null> {
    return this.enqueueOperation({ namespace, id } as GetOperation);
  }

  async search(
    namespacePrefix: string[],
    options?: {
      filter?: Record<string, any>;
      limit?: number;
      offset?: number;
    }
  ): Promise<Item[]> {
    const { filter, limit = 10, offset = 0 } = options || {};
    return this.enqueueOperation({
      namespacePrefix,
      filter,
      limit,
      offset,
    } as SearchOperation);
  }

  async put(
    namespace: string[],
    id: string,
    value: Record<string, any>
  ): Promise<void> {
    return this.enqueueOperation({ namespace, id, value } as PutOperation);
  }

  async delete(namespace: string[], id: string): Promise<void> {
    return this.enqueueOperation({
      namespace,
      id,
      value: null,
    } as PutOperation);
  }

  start(): void {
    if (!this.running) {
      this.running = true;
      this.processingTask = this.processBatchQueue();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.processingTask) {
      await this.processingTask;
    }
  }

  private enqueueOperation<T>(operation: Operation): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const key = Symbol();
      this.queue.set(key, { operation, resolve, reject });
    });
  }

  private async processBatchQueue(): Promise<void> {
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.queue.size === 0) continue;

      const batch = new Map(this.queue);
      this.queue.clear();

      try {
        const operations = Array.from(batch.values()).map(
          ({ operation }) => operation
        );
        const results = await this.store.batch(operations);

        batch.forEach(({ resolve }, key) => {
          const index = Array.from(batch.keys()).indexOf(key);
          resolve(results[index]);
        });
      } catch (e) {
        batch.forEach(({ reject }) => {
          reject(e);
        });
      }
    }
  }
}
