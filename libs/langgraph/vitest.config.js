import { configDefaults, defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  const common = {
    test: {
      hideSkippedTests: true,
      globals: true,
      testTimeout: 30_000,
      exclude: ["**/*.int.test.ts", "**/*.bench.test.ts", ...configDefaults.exclude],
    },
  };

  if (env.mode === "bench") {
    return {
      test: {
        globals: true,
        include: ["**/*.bench.test.ts"],
        testTimeout: 300_000, // 5 minutes for benchmarks
        benchmark: {
          include: ["**/*.bench.test.ts"],
        },
      },
    }
  }

  if (env.mode === "int") {
    return {
      test: {
        ...common.test,
        minWorkers: 0.5,
        testTimeout: 100_000,
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
        environment: "node",
      },
    };
  }

  if (env.mode === "browser") {
    return {
      test: {
        ...common.test,
        browser: {
          provider: "playwright",
          enabled: true,
          instances: [{ browser: "chromium" }],
        },
      },
      plugins: [nodePolyfills()],
    };
  }

  return {
    test: {
      ...common.test,
      name: "unit",
      environment: "node",
      include: ["**/*.test-d.ts", ...configDefaults.include],
      typecheck: { enabled: true },
    },
  };
});
