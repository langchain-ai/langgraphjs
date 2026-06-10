/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { initializeAsyncLocalStorageSingleton } from "./node.js";

// Initialize global async local storage instance for tracing
initializeAsyncLocalStorageSingleton();

export * from "./web.js";
