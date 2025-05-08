import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

export function initializeAsyncLocalStorageSingleton(): void {
  try {
    // Attempt to require "async_hooks" only in environments where it's available.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { AsyncLocalStorage } = require("node:async_hooks");
    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
      new AsyncLocalStorage()
    );
  } catch (e) {
    // If "async_hooks" is not available (e.g., browser, React Native),
    // this function becomes a no-op as no initialization call is made.
    // You can uncomment the following line to log a warning in such cases:
    // console.warn("async_hooks module not available. AsyncLocalStorage features will be disabled.");
  }
}
