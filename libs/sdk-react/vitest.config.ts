import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { webdriverio } from "@vitest/browser-webdriverio";

export default defineConfig({
  plugins: [react()],
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
    include: ["src/**/*.test.tsx"],
    exclude: ["**/*.test-d.ts"],
    typecheck: {
      enabled: true,
      include: ["**/*.test-d.ts"],
    },
  },
});
