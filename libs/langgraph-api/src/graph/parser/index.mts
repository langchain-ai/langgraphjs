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

type GraphSchemaWithSubgraphs = Record<string, GraphSchema>;

const isGraphSpec = (spec: unknown): spec is GraphSpec => {
  if (typeof spec !== "object" || spec == null) return false;
  if (!("sourceFile" in spec) || typeof spec.sourceFile !== "string")
    return false;
  if (!("exportSymbol" in spec) || typeof spec.exportSymbol !== "string")
    return false;

  return true;
};

export async function getStaticGraphSchema(
  spec: GraphSpec,
  options?: { mainThread?: boolean; timeoutMs?: number }
): Promise<GraphSchemaWithSubgraphs>;

export async function getStaticGraphSchema(
  specMap: Record<string, GraphSpec>,
  options?: { mainThread?: boolean; timeoutMs?: number }
): Promise<Record<string, GraphSchemaWithSubgraphs>>;

export async function getStaticGraphSchema(
  input: Record<string, GraphSpec> | GraphSpec,
  options?: { mainThread?: boolean; timeoutMs?: number }
): Promise<
  Record<string, GraphSchemaWithSubgraphs> | GraphSchemaWithSubgraphs
> {
  async function execute(
    specs: GraphSpec[]
  ): Promise<GraphSchemaWithSubgraphs[]> {
    if (options?.mainThread) {
      const { SubgraphExtractor } = await import("./parser.mjs");
      return SubgraphExtractor.extractSchemas(specs, { strict: false });
    }

    return await new Promise<Record<string, GraphSchema>[]>(
      (resolve, reject) => {
        const worker = new Worker(
          fileURLToPath(new URL("./parser.worker.mjs", import.meta.url)),
          { argv: process.argv.slice(-1) }
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
        worker.postMessage(specs);
      }
    );
  }

  const specs = isGraphSpec(input) ? [input] : Object.values(input);
  const results = await execute(specs);

  if (isGraphSpec(input)) {
    return results[0];
  }

  return Object.fromEntries(
    Object.keys(input).map((graphId, idx) => [graphId, results[idx]])
  );
}

export async function getRuntimeGraphSchema(
  graph: Pregel<any, any, any, any, any>
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
