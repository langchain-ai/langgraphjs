/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { initializeAsyncLocalStorageSingleton } from "./setup/async_local_storage.js";

// Initialize global async local storage instance for tracing
initializeAsyncLocalStorageSingleton();

export * from "./web.js";
