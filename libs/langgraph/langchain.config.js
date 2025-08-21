import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} relativePath
 * @returns {string}
 */
function abs(relativePath) {
  return resolve(dirname(fileURLToPath(import.meta.url)), relativePath);
}

export const config = {
  internals: [/node\:/, /@langchain\/core\//, /async_hooks/, /zod\/v[34]/],
  entrypoints: {
    index: "index",
    web: "web",
    pregel: "pregel/index",
    prebuilt: "prebuilt/index",
    remote: "remote",
    zod: "graph/zod/index",
    "zod/schema": "graph/zod/schema",
    "ui": "ui/index"
  },
  tsConfigPath: resolve("./tsconfig.json"),
  cjsSource: "./dist-cjs",
  cjsDestination: "./dist",
  abs,
};
