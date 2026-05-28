import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import { webdriverio } from "@vitest/browser-webdriverio";

export default defineConfig({
  plugins: [vue(), vueJsx()],
  resolve: {},
  test: {
    globals: true,
    testTimeout: 5_000,
    retry: 1,
    globalSetup: ["./src/tests/fixtures/mock-server.ts"],
    browser: {
      enabled: true,
      connectTimeout: 20_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    typecheck: {
      enabled: true,
    },
  },
});
