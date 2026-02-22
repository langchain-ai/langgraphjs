import { resolve } from "path";
import { transformWithEsbuild } from "vite";
import { defineConfig } from "vitest/config";
import angular from "@analogjs/vite-plugin-angular";

const nonAngularFiles = [/mock-server\.ts/, /vitest-browser-shim\.ts/];

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
    // @ts-expect-error - Angular plugin is not correctly typed
    angular({
      tsconfig: "tsconfig.spec.json",
      transformFilter(_code: string, id: string) {
        return !nonAngularFiles.some((re) => re.test(id));
      },
    }),
  ],
  resolve: {
    alias: {
      "vitest/browser": resolve(
        __dirname,
        "src/tests/vitest-browser-shim.ts"
      ),
    },
  },
  test: {
    globals: true,
    testTimeout: 30_000,
    globalSetup: ["./src/tests/mock-server.ts"],
    setupFiles: ["./src/tests/setup.ts"],
    browser: {
      enabled: true,
      provider: "webdriverio",
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
      tsconfig: "tsconfig.typecheck.json",
    },
  },
});
