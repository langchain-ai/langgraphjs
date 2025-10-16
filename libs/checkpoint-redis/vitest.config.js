import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  const common = {
    test: {
      hideSkippedTests: true,
      passWithNoTests: true,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
    }
  }

  if (env.mode === "int") {
    return {
      test: {
        ...common.test,

        testTimeout: 60_000,
        maxConcurrency: 5,
        fileParallelism: false, // Sequential to avoid Docker resource limits
        pool: "forks", // Use forks instead of threads to avoid cleanup issues
        poolOptions: {
          forks: {
            singleFork: true, // Run all tests in a single fork to control cleanup
          },
        },
        onConsoleLog(log) {
          // Filter out TestContainers logs to reduce noise
          if (log.includes("testcontainers") || log.includes("docker")) {
            return false;
          }
        },
        exclude: configDefaults.exclude,
        include: ["**/*.int.test.ts"],
        name: "int",
        environment: "node",
      },
    }
  }

  return {
    test: {
      ...common.test,
      name: "unit",
      environment: "node",
    },
  }
});
