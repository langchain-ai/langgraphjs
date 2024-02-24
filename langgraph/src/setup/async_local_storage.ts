import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { AsyncLocalStorage } from "async_hooks";

export function initializeAsyncLocalStorage() {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
    new AsyncLocalStorage()
  );
}
