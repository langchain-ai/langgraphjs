import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { defineConfig } from "vitest/config";
import angular from "@analogjs/vite-plugin-angular";
import { webdriverio } from "@vitest/browser-webdriverio";

const workspaceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const nonAngularFiles = [
  /mock-server\.ts/,
  /browser-fixtures\.ts/,
  /vitest-browser-shim\.ts/,
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
