import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

export function initializeAsyncLocalStorageSingleton() {
  if (typeof require !== "undefined") {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const { AsyncLocalStorage } = require("node:async_hooks");

    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
      new AsyncLocalStorage()
    );
  }
}
