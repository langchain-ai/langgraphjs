import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@langchain/langgraph-sdk/utils": r("../sdk/src/utils/index.ts"),
      "@langchain/langgraph-sdk/ui": r("../sdk/src/ui/index.ts"),
      "@langchain/langgraph-sdk/client": r("../sdk/src/client.ts"),
      "@langchain/langgraph-sdk": r("../sdk/src/index.ts"),
    },
  },
});
