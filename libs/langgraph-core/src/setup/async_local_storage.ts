import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AsyncHooksModule = { AsyncLocalStorage: new () => any };

interface NodeProcess {
  getBuiltinModule?: (id: string) => Record<string, unknown> | undefined;
}

let asyncLocalStorageInitialization: Promise<boolean> | undefined;
let asyncLocalStorageInitialized = false;

/**
 * Attempt a synchronous resolve of `node:async_hooks` via the
 * `process.getBuiltinModule` API (Node.js >= 20.16.0). Returns the module
 * or `undefined` in older runtimes / browsers.
 */
function tryGetBuiltinModule(): AsyncHooksModule | undefined {
  try {
    const mod = (
      globalThis as unknown as { process?: NodeProcess }
    ).process?.getBuiltinModule?.("node:async_hooks");
    if (mod?.AsyncLocalStorage) return mod as AsyncHooksModule;
  } catch {
    // not available
  }
  return undefined;
}

function initFromModule(mod: AsyncHooksModule): void {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(
    new mod.AsyncLocalStorage()
  );
  asyncLocalStorageInitialized = true;
}

export function isAsyncLocalStorageSingletonInitialized(): boolean {
  return asyncLocalStorageInitialized;
}

/**
 * Initializes the global {@link AsyncLocalStorage} singleton used for
 * implicit config propagation.
 *
 * 1. Tries `process.getBuiltinModule("node:async_hooks")` for a **synchronous**
 *    initialisation (Node.js >= 20.16.0).
 * 2. Falls back to a dynamic import with bundler ignore hints so that bundlers
 *    targeting browser environments (e.g. Vite, webpack/Next.js) won't try to
 *    resolve the Node builtin at build time.
 *    In browsers the import is silently skipped and callers must pass config
 *    explicitly (same behaviour as the `@langchain/langgraph/web` entry).
 */
export function initializeAsyncLocalStorageSingleton(): Promise<boolean> {
  if (asyncLocalStorageInitialization !== undefined) {
    return asyncLocalStorageInitialization;
  }

  const builtinMod = tryGetBuiltinModule();
  if (builtinMod) {
    initFromModule(builtinMod);
    asyncLocalStorageInitialization = Promise.resolve(true);
    return asyncLocalStorageInitialization;
  }

  asyncLocalStorageInitialization = import(
    /* webpackIgnore: true */
    /* @vite-ignore */
    "node:async_hooks"
  )
    .then((mod) => {
      initFromModule(mod);
      return true;
    })
    .catch(() => {
      return false;
    });

  return asyncLocalStorageInitialization;
}
