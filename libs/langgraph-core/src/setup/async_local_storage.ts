import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { AsyncLocalStorage } from "node:async_hooks";

export function initializeAsyncLocalStorageSingleton() {
  /**
   * We don't need to initialize the async local storage singleton
   * in environments that don't support node:async_hooks.
   */
  if (typeof process === 'undefined' || !process.versions?.node) {
    return;
  }
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
    new AsyncLocalStorage()
  );
}
