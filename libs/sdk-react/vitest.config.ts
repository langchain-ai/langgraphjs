import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    testTimeout: 30_000,
    globalSetup: ["./src/tests/mock-server.ts"],
    browser: {
      enabled: true,
      provider: "webdriverio",
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.tsx"],
    typecheck: {
      enabled: true,
    },
  },
});
