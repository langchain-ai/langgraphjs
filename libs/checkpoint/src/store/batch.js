"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncBatchedStore = void 0;
const base_js_1 = require("./base.js");
class AsyncBatchedStore extends base_js_1.BaseStore {
  constructor(store) {
    super();
    Object.defineProperty(this, "store", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0,
    });
    Object.defineProperty(this, "queue", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: new Map(),
    });
    Object.defineProperty(this, "running", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(this, "processingTask", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: null,
    });
    this.store = store;
  }
  get isRunning() {
    return this.running;
  }
  async get(namespace, id) {
    return this.enqueueOperation({ namespace, id });
  }
  async search(namespacePrefix, options) {
    const { filter, limit = 10, offset = 0 } = options || {};
    return this.enqueueOperation({
      namespacePrefix,
      filter,
      limit,
      offset,
    });
  }
  async put(namespace, id, value) {
    return this.enqueueOperation({ namespace, id, value });
  }
  async delete(namespace, id) {
    return this.enqueueOperation({ namespace, id, value: null });
  }
  start() {
    if (!this.running) {
      this.running = true;
      this.processingTask = this.processBatchQueue();
    }
  }
  async stop() {
    this.running = false;
    if (this.processingTask) {
      await this.processingTask;
    }
  }
  enqueueOperation(operation) {
    return new Promise((resolve, reject) => {
      const key = Symbol();
      this.queue.set(key, { operation, resolve, reject });
    });
  }
  async processBatchQueue() {
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
exports.AsyncBatchedStore = AsyncBatchedStore;
