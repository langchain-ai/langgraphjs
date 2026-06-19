import { defineConfig } from "vitest/config";

export default defineConfig(() => {
  /** @type {import("vitest/config").UserConfigExport} */
  return {
    test: {
      hideSkippedTests: true,
      testTimeout: 30_000,
      fileParallelism: false,
    },
  };
});
