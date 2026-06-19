import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Minimal AsyncLocalStorage for browser test environments (no node:async_hooks).
 * Restores context when returned promises settle, matching Node ALS behavior for
 * async callbacks (e.g. runWithConfig + getCurrentTaskInput after await).
 */
class BrowserAsyncLocalStorage {
  #store: unknown;

  getStore(): unknown {
    return this.#store;
  }

  run<R>(store: unknown, callback: () => R): R {
    const previous = this.#store;
    this.#store = store;
    let restoreOnSyncExit = true;
    try {
      const result = callback();
      if (isThenable(result)) {
        restoreOnSyncExit = false;
        return Promise.resolve(result).finally(() => {
          this.#store = previous;
        }) as R;
      }
      return result;
    } finally {
      if (restoreOnSyncExit) {
        this.#store = previous;
      }
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
