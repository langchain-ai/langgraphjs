import { afterEach, inject } from "vitest";
import { cleanup } from "vitest-browser-vue";

/**
 * Shared vitest setup for `stream.*.test.ts` / `.tsx` files. Runs the
 * composable against a single shared mock server; every test cleans up
 * any residual Vue roots after it finishes so the controller's
 * deferred-dispose cleanup fires before the next test starts.
 */
export const apiUrl = inject("serverUrl");

afterEach(async () => {
  await cleanup();
  // Give any in-flight controller work (hydrate fetches,
  // deferred-dispose cleanup, queued state snapshots) time to unwind
  // before the next test mounts its own Vue tree.
  await new Promise((resolve) => setTimeout(resolve, 200));
});
