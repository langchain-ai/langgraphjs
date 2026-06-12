import { configDefaults, defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
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
        fileParallelism: false,
        maxConcurrency: 1,
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
        setupFiles: ["./src/tests/setup.browser.ts"],
        // Node-only: implicit RunnableConfig via async_hooks, LangSmith tracing env, or
        // timing-sensitive AbortSignal/cancellation behavior not reliable in Chromium.
        exclude: [
          ...common.test.exclude,
          "src/tests/utils.test.ts",
          "src/tests/func.test.ts",
          "src/tests/tracing.test.ts",
          "src/tests/pregel/pregel.cancellation.test.ts",
          "src/tests/python_port/interrupt.test.ts",
          "src/tests/python_port/graph_structure.test.ts",
        ],
        browser: {
          provider: playwright(),
          enabled: true,
          instances: [{ browser: "chromium" }],
        },
      },
      plugins: [
        nodePolyfills({
          globals: {
            Buffer: true,
            global: true,
            process: true,
          },
          protocolImports: true,
        }),
      ],
    };
  }

  return {
    test: {
      ...common.test,
      name: "unit",
      environment: "node",
      setupFiles: [
        "./src/tests/setup.node.ts",
        "./src/tests/matchers/setup.ts",
      ],
      include: ["**/*.test-d.ts", ...configDefaults.include],
      typecheck: { enabled: true },
    },
  };
});
