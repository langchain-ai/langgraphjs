import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

export function initializeAsyncLocalStorageSingleton() {
  if (typeof process === "undefined" || !process.versions?.node) {
    return;
  }

  // Construct the module specifier at runtime to prevent bundlers
  // from statically resolving and inlining the Node.js built-in.
  const mod = ["node", "async_hooks"].join(":");
  import(/* webpackIgnore: true */ mod)
    .then(({ AsyncLocalStorage }) => {
      AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
        new AsyncLocalStorage()
      );
    })
    .catch(() => {
      // AsyncLocalStorage not available in this runtime
    });
}
