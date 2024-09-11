import { BaseStore, type Values } from "./base.js";

interface ListOp {
  prefixes: string[];
}

interface PutOp {
  writes: Array<[string, string, Values | null]>;
}

type QueueItem = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve: (value?: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reject: (reason?: any) => void;
  op: ListOp | PutOp;
};

/**
 * AsyncBatchedStore extends BaseStore to provide batched operations for list and put methods.
 * It queues operations and processes them in batches for improved efficiency. This store is
 * designed to run for the full duration of the process, or until `stop()` is called.
 */
export class AsyncBatchedStore extends BaseStore {
  private store: BaseStore;

  private queue: QueueItem[] = [];

  private running = true;

  constructor(store: BaseStore) {
    super();
    this.store = store;
    void this.runTask();
  }

  /**
   * Queues a list operation to be processed in batch.
   * @param {string[]} prefixes An array of prefixes to list.
   * @returns {Promise<Record<string, Record<string, Values>>>} A promise that resolves with the list results.
   */
  async list(
    prefixes: string[]
  ): Promise<Record<string, Record<string, Values>>> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, op: { prefixes } });
    });
  }

  /**
   * Queues a put operation to be processed in batch.
   * @param {Array<[string, string, Values | null]>} writes An array of write operations to be performed.
   * @returns {Promise<void>} A promise that resolves when the put operation is complete.
   */
  async put(writes: Array<[string, string, Values | null]>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, op: { writes } });
    });
  }

  /**
   * Stops the batched processing of operations.
   */
  stop() {
    this.running = false;
  }

  /**
   * Runs the task that processes queued operations in batches.
   * This method runs continuously until the store is stopped,
   * or the process is terminated.
   * @returns {Promise<void>} A promise that resolves when the task is complete.
   */
  private async runTask(): Promise<void> {
    while (this.running) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      if (this.queue.length === 0) continue;

      const taken = this.queue.splice(0);

      const lists = taken.filter((item) => "prefixes" in item.op);
      if (lists.length > 0) {
        try {
          const allPrefixes = lists.flatMap(
            (item) => (item.op as ListOp).prefixes
          );
          const results = await this.store.list(allPrefixes);
          lists.forEach((item) => {
            const { prefixes } = item.op as ListOp;
            item.resolve(
              Object.fromEntries(prefixes.map((p) => [p, results[p] || {}]))
            );
          });
        } catch (e) {
          lists.forEach((item) => item.reject(e));
        }
      }

      const puts = taken.filter((item) => "writes" in item.op);
      if (puts.length > 0) {
        try {
          const allWrites = puts.flatMap((item) => (item.op as PutOp).writes);
          await this.store.put(allWrites);
          puts.forEach((item) => item.resolve());
        } catch (e) {
          puts.forEach((item) => item.reject(e));
        }
      }
    }
  }
}
