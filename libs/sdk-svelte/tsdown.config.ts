import { defineConfig } from "tsdown";
import { compileModule } from "svelte/compiler";
import { transformSync } from "esbuild";

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
    },
  ],
});
