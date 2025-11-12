import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  return {
    test: {
      hideSkippedTests: true,
      globals: true,
      testTimeout: 30_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
      passWithNoTests: true,
      name: "unit",
      environment: "node",
    },
  };
});
