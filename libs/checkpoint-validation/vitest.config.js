import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  return {
    test: {
      ...configDefaults,
      globals: true,
      testTimeout: 120000, // 2 minutes for AWS throttling
      hookTimeout: 120000, // 2 minutes for setup hooks
      chaiConfig: {
        truncateThreshold: 100_000,
      },
    },
  };
});
