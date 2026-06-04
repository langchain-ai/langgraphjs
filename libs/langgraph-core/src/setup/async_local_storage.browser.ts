import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

/**
 * Minimal AsyncLocalStorage for browser test environments (no node:async_hooks).
 * Supports sequential async/await flows in tests; not for production browser use.
 */
class BrowserAsyncLocalStorage {
  #store: unknown;

  getStore(): unknown {
    return this.#store;
  }

  run<R>(store: unknown, callback: () => R): R {
    const previous = this.#store;
    this.#store = store;
    try {
      return callback();
    } finally {
      this.#store = previous;
    }
  }

  enterWith(store: unknown): void {
    this.#store = store;
  }
}

export function initializeAsyncLocalStorageSingleton() {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
    new BrowserAsyncLocalStorage()
  );
}
