import { defineConfig } from "tsdown";
import { compileModule } from "svelte/compiler";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm", "cjs"],
  outDir: "./dist",
  platform: "neutral",
  target: "es2022",
  unbundle: true,
  fixedExtension: false,
  sourcemap: true,
  clean: true,
  dts: {
    parallel: true,
    sourcemap: true,
    tsgo: true,
  },
  tsconfig: "./tsconfig.json",
  attw: {
    profile: "node16",
    level: "error",
  },
  publint: {
    level: "error",
    strict: true,
  },
  plugins: [
    {
      name: "svelte-runes",
      transform(code: string, id: string) {
        if (id.includes("node_modules")) return undefined;
        if (!id.endsWith(".ts") && !id.endsWith(".js")) return undefined;
        if (
          !code.includes("$state") &&
          !code.includes("$derived") &&
          !code.includes("$effect")
        )
          return undefined;

        const result = compileModule(code, {
          filename: id.replace(/\.ts$/, ".svelte.ts"),
          generate: "client",
        });

        return {
          code: result.js.code,
          map: result.js.map,
        };
      },
    },
  ],
});
