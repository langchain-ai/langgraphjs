import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  return {
    test: {
      ...configDefaults,
      globals: true,
      chaiConfig: {
        truncateThreshold: 100_000,
      },
    },
  };
});
