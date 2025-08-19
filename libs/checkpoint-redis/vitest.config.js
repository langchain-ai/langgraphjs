import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.int.test.ts"],
    exclude: ["**/old/**", "**/node_modules/**"],
    testTimeout: 60000,
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
  },
});
