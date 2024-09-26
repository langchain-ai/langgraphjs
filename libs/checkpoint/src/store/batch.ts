import {
  BaseStore,
  type Item,
  type SearchOperation,
  type PutOperation,
  type GetOperation,
  type Operation,
} from "./base.js";

/**
 * AsyncBatchedStore extends BaseStore to provide batched operations for list and put methods.
 * It queues operations and processes them in batches for improved efficiency. This store is
 * designed to run for the full duration of the process, or until `stop()` is called.
 */
export class AsyncBatchedStore extends BaseStore {
  private store: BaseStore;
  private queue: Map<Promise<any>, Operation> = new Map();
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
    const promise = new Promise<Item | null>((resolve, reject) => {
      this.queue.set(promise, { namespace, id } as GetOperation);
      promise.then(resolve, reject);
    });
    return promise;
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
    const promise = new Promise<Item[]>((resolve, reject) => {
      this.queue.set(promise, {
        namespacePrefix,
        filter,
        limit,
        offset,
      } as SearchOperation);
      promise.then(resolve, reject);
    });
    return promise;
  }

  async put(
    namespace: string[],
    id: string,
    value: Record<string, any>
  ): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.set(promise, { namespace, id, value } as PutOperation);
      promise.then(resolve, reject);
    });
    return promise;
  }

  async delete(namespace: string[], id: string): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.queue.set(promise, { namespace, id, value: null } as PutOperation);
      promise.then(resolve, reject);
    });
    return promise;
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

  private async processBatchQueue(): Promise<void> {
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.queue.size === 0) continue;

      const taken = new Map(this.queue);
      this.queue.clear();

      try {
        const results = await this.store.batch(Array.from(taken.values()));
        taken.forEach((_, promise) => {
          (promise as any).resolve(
            results[Array.from(taken.keys()).indexOf(promise)]
          );
        });
      } catch (e) {
        taken.forEach((_, promise) => {
          (promise as any).reject(e);
        });
      }
    }
  }
}
