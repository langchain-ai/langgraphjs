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
  internals: [/node\:/, /@langchain\/core\//, /async_hooks/],
  entrypoints: {
    index: "index",
    web: "web",
    pregel: "pregel/index",
    prebuilt: "prebuilt/index",
    "checkpoint/sqlite": "checkpoint/sqlite",
    messages: "graph/messages_state"
  },
  tsConfigPath: resolve("./tsconfig.json"),
  cjsSource: "./dist-cjs",
  cjsDestination: "./dist",
  abs,
};
