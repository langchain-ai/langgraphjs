import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";

export default defineConfig({
  plugins: [vue(), vueJsx()],
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
