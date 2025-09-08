/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */

import { initializeAsyncLocalStorageSingleton } from "./setup/async_local_storage.js";

// Initialize global async local storage instance for tracing
initializeAsyncLocalStorageSingleton();

export * from "./web.js";

export { interrupt } from "./interrupt.js";
export { writer } from "./writer.js";
export { getStore, getWriter, getConfig } from "./pregel/utils/config.js";
export { getPreviousState } from "./func/index.js";
export { getCurrentTaskInput } from "./pregel/utils/config.js";
