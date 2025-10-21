import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { AsyncLocalStorage } from "node:async_hooks";

export function initializeAsyncLocalStorageSingleton() {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
    new AsyncLocalStorage()
  );
}
