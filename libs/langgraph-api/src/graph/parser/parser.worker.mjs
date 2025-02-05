import { tsImport } from "tsx/esm/api";
import { parentPort } from "node:worker_threads";

parentPort?.on("message", async (payload) => {
  const { SubgraphExtractor } = await tsImport("./parser.mjs", import.meta.url);
  const result = SubgraphExtractor.extractSchemas(
    payload.sourceFile,
    payload.exportSymbol,
    { strict: false },
  );
  parentPort?.postMessage(result);
});
