import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  test: {
    globals: true,
    testTimeout: 30_000,
    globalSetup: ["./src/tests/mock-server.ts"],
    browser: {
      enabled: true,
      provider: "webdriverio",
      name: "chrome",
      headless: true,
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
    },
  },
});
