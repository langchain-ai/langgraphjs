import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    fileParallelism: false,
    maxConcurrency: 1,
    include: ["**/*.test.ts"],
    testTimeout: 300_000, // 5 minutes for benchmarks
    benchmark: {
      include: ["**/*.test.ts"],
    },
  },
});
