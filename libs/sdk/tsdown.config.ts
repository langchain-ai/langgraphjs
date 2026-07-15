import { defineConfig } from "@langchain/build";

export default defineConfig({
  // `p-retry` and `p-queue` are pure-ESM packages. The SDK exports both
  // ESM and CJS, so we need to bundle them the build output.
  noExternal: ["p-retry", "p-queue"],
});
