import { configDefaults, defineConfig } from "vitest/config";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import process from "node:process";

export default defineConfig({
  test: {
    workspace: [
      {
        test: {
          exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
          name: "unit",
          environment: "node",
          globals: true,
        },
      },
      {
        test: {
          exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
          globals: true,
          browser: {
            provider: "playwright",
            enabled: process.env.BROWSER_TEST === "true",
            instances: [{ browser: "chromium" }],
          },
        },
        plugins: [nodePolyfills()],
      },
    ],
  },
});
