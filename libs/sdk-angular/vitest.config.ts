import { transformWithEsbuild } from "vite";
import { defineConfig } from "vitest/config";
import angular from "@analogjs/vite-plugin-angular";
import { webdriverio } from "@vitest/browser-webdriverio";
import { fileURLToPath } from "node:url";

const nonAngularFiles = [
  /mock-server\.ts/,
  /vitest-browser-shim\.ts/,
  /\.test-d\.ts$/,
];

export default defineConfig({
  plugins: [
    {
      name: "esbuild-ts-fallback",
      enforce: "pre",
      async transform(code, id) {
        if (nonAngularFiles.some((re) => re.test(id))) {
          return transformWithEsbuild(code, id);
        }
      },
    },
    angular({
      tsconfig: "tsconfig.spec.json",
      transformFilter(_code: string, id: string) {
        return !nonAngularFiles.some((re) => re.test(id));
      },
    }),
  ],
  optimizeDeps: {
    exclude: [
      "@analogjs/vitest-angular/setup-testbed",
      "vitest",
      "vitest/browser",
      "vitest-browser-angular",
    ],
  },
  resolve: {
    alias: {
      "vitest-browser-angular": fileURLToPath(
        new URL(
          "./node_modules/vitest-browser-angular/dist/pure.mjs",
          import.meta.url
        )
      ),
    },
  },
  test: {
    globals: true,
    fileParallelism: false,
    testTimeout: 5_000,
    retry: 1,
    globalSetup: ["./src/tests/fixtures/mock-server.ts"],
    setupFiles: ["./src/tests/setup.ts"],
    browser: {
      enabled: true,
      connectTimeout: 120_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
      tsconfig: "tsconfig.typecheck.json",
    },
  },
});
