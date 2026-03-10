import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { webdriverio } from "@vitest/browser-webdriverio";

export default defineConfig({
  plugins: [svelte()],
  test: {
    globals: true,
    testTimeout: 30_000,
    retry: 2,
    globalSetup: ["./src/tests/fixtures/mock-server.ts"],
    browser: {
      enabled: true,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
    },
  },
});
