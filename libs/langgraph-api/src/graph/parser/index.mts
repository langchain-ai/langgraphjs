import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { JSONSchema7 } from "json-schema";
import type { Pregel } from "@langchain/langgraph";

export interface GraphSchema {
  state: JSONSchema7 | undefined;
  input: JSONSchema7 | undefined;
  output: JSONSchema7 | undefined;
  config: JSONSchema7 | undefined;
}

export interface GraphSpec {
  sourceFile: string;
  exportSymbol: string;
}

export async function getStaticGraphSchema(
  spec: GraphSpec,
  options?: { mainThread?: boolean; timeoutMs?: number },
): Promise<Record<string, GraphSchema>> {
  if (options?.mainThread) {
    const { SubgraphExtractor } = await import("./parser.mjs");
    return SubgraphExtractor.extractSchemas(
      spec.sourceFile,
      spec.exportSymbol,
      { strict: false },
    );
  }

  return await new Promise<Record<string, GraphSchema>>((resolve, reject) => {
    const worker = new Worker(
      fileURLToPath(new URL("./parser/parser.worker.mjs", import.meta.url)),
      { argv: process.argv.slice(-1) },
    );

    // Set a timeout to reject if the worker takes too long
    const timeoutId = setTimeout(() => {
      worker.terminate();
      reject(new Error("Schema extract worker timed out"));
    }, options?.timeoutMs ?? 30000);

    worker.on("message", (result) => {
      worker.terminate();
      clearTimeout(timeoutId);
      resolve(result);
    });

    worker.on("error", reject);
    worker.postMessage(spec);
  });
}

export async function getRuntimeGraphSchema(
  graph: Pregel<any, any, any, any, any>,
): Promise<GraphSchema | undefined> {
  try {
    const {
      getInputTypeSchema,
      getOutputTypeSchema,
      getUpdateTypeSchema,
      getConfigTypeSchema,
    } = await import("@langchain/langgraph/zod/schema");

    const result = {
      state: getUpdateTypeSchema(graph),
      input: getInputTypeSchema(graph),
      output: getOutputTypeSchema(graph),
      config: getConfigTypeSchema(graph),
    } as GraphSchema;

    if (Object.values(result).every((i) => i == null)) return undefined;
    return result;
  } catch {
    // ignore
  }

  return undefined;
}
