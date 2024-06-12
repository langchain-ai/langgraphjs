import { initializeAsyncLocalStorageSingleton } from "./setup/async_local_storage.js";

// Initialize global async local storage instance for tracing
/* #__PURE__ */ initializeAsyncLocalStorageSingleton();

export * from "./web.js";
