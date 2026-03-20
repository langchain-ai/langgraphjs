import { defineConfig, type Plugin } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { webdriverio } from "@vitest/browser-webdriverio";
import { compileModule } from "svelte/compiler";
import { transformSync } from "esbuild";

function svelteRunesPlugin(): Plugin {
  return {
    name: "svelte-runes",
    enforce: "pre",
    transform(code: string, id: string) {
      if (id.includes("node_modules")) return undefined;
      if (id.endsWith(".svelte")) return undefined;
      if (!id.endsWith(".ts") && !id.endsWith(".js")) return undefined;
      if (id.endsWith(".test.ts") || id.endsWith(".test-d.ts"))
        return undefined;
      if (id.includes("/fixtures/")) return undefined;
      if (
        !code.includes("$state(") &&
        !code.includes("$state<") &&
        !code.includes("$derived") &&
        !code.includes("$effect(")
      )
        return undefined;

      const stripped = id.endsWith(".ts")
        ? transformSync(code, {
            loader: "ts",
            format: "esm",
            target: "esnext",
          }).code
        : code;

      const result = compileModule(stripped, {
        filename: id.replace(/\.ts$/, ".svelte.js"),
        generate: "client",
      });

      return {
        code: result.js.code,
        map: result.js.map,
      };
    },
  };
}

export default defineConfig({
  plugins: [svelteRunesPlugin(), svelte()],
  test: {
    globals: true,
    testTimeout: 30_000,
    retry: 2,
    globalSetup: ["./src/tests/fixtures/mock-server.ts"],
    browser: {
      enabled: true,
      connectTimeout: 120_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
    },
  },
});
