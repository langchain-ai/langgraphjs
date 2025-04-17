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
        },
      },
      {
        test: {
          exclude: ["**/*.int.test.ts", ...configDefaults.exclude],
          browser: {
            provider: "playwright",
            enabled: process.env.BROWSER_TEST === "true",
            instances: [{ browser: "chromium" }],
          },
          // its fine if test fails, we just want to run it
          // dont exit on error
        },
        plugins: [nodePolyfills()],
      },
    ],
  },
});
