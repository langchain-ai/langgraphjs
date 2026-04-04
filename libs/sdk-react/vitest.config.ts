import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { webdriverio } from "@vitest/browser-webdriverio";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@langchain/langgraph-api/experimental/embed": resolve(
        workspaceRoot,
        "libs/langgraph-api/src/experimental/embed.mts"
      ),
    },
  },
  test: {
    globals: true,
    testTimeout: 30_000,
    retry: 2,
    globalSetup: ["./src/tests/fixtures/mock-server.ts"],
    browser: {
      enabled: true,
      connectTimeout: 120_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.tsx"],
    exclude: ["**/*.test-d.ts"],
    typecheck: {
      enabled: true,
      include: ["**/*.test-d.ts"],
    },
  },
});
