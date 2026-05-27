import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  const common = {
    test: {
      hideSkippedTests: true,
      globals: true,
      testTimeout: 30_000,
      exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
      passWithNoTests: true,
    },
  };

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

  return {
    test: {
      ...common.test,
      name: "unit",
      environment: "node",
    },
  };
});
