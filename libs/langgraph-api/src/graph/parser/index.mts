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

// Symbol used when input inherits from state schema but as partial
const PartialStateSchema = Symbol.for("langgraph.state.partial");

/**
 * Type for graph builder internal properties.
 * @internal
 */
interface GraphBuilder {
  _schemaRuntimeDefinition?: unknown;
  _inputRuntimeDefinition?: unknown;
  _outputRuntimeDefinition?: unknown;
  _configRuntimeSchema?: unknown;
}

/**
 * Duck-type check for StateSchema-like objects.
 * Checks for getJsonSchema and getInputJsonSchema methods.
 */
interface StateSchemaLike {
  getJsonSchema(): unknown;
  getInputJsonSchema(): unknown;
}

function isStateSchemaLike(value: unknown): value is StateSchemaLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "getJsonSchema" in value &&
    typeof (value as StateSchemaLike).getJsonSchema === "function" &&
    "getInputJsonSchema" in value &&
    typeof (value as StateSchemaLike).getInputJsonSchema === "function"
  );
}

/**
 * Try to extract schema from StateSchema instance.
 * StateSchema handles jsonSchemaExtra internally via ReducedValue.jsonSchemaExtra
 *
 * @param graph - The compiled graph to extract schemas from
 * @returns GraphSchema if StateSchema instances found, undefined otherwise
 */
async function tryStateSchemaExtraction(
  graph: Pregel<any, any, any, any, any>
): Promise<GraphSchema | undefined> {
  const builder = (graph as unknown as { builder?: GraphBuilder }).builder;
  if (!builder) return undefined;

  // Check if ANY of the schemas are StateSchema-like (have getJsonSchema/getInputJsonSchema methods)
  const schemaDefIsLike = isStateSchemaLike(builder._schemaRuntimeDefinition);
  const inputDefIsLike = isStateSchemaLike(builder._inputRuntimeDefinition);
  const outputDefIsLike = isStateSchemaLike(builder._outputRuntimeDefinition);
  const hasStateSchema = schemaDefIsLike || inputDefIsLike || outputDefIsLike;

  if (!hasStateSchema) return undefined;

  // Extract from StateSchema-like instances
  const state = isStateSchemaLike(builder._schemaRuntimeDefinition)
    ? (builder._schemaRuntimeDefinition.getJsonSchema() as JSONSchema7)
    : undefined;

  const input = (() => {
    if (isStateSchemaLike(builder._inputRuntimeDefinition)) {
      return builder._inputRuntimeDefinition.getInputJsonSchema() as JSONSchema7;
    }
    // PartialStateSchema means input inherits from state as partial
    if (
      builder._inputRuntimeDefinition === PartialStateSchema &&
      isStateSchemaLike(builder._schemaRuntimeDefinition)
    ) {
      return builder._schemaRuntimeDefinition.getInputJsonSchema() as JSONSchema7;
    }
    return undefined;
  })();

  const output = isStateSchemaLike(builder._outputRuntimeDefinition)
    ? (builder._outputRuntimeDefinition.getJsonSchema() as JSONSchema7)
    : undefined;

  // StateSchema doesn't have config schema support yet
  const config = undefined;

  if (!state && !input && !output) return undefined;
  return { state, input, output, config };
}

/**
 * Try existing Zod extraction via schemaMetaRegistry.
 * This handles jsonSchemaExtra from withLangGraph() calls.
 *
 * @param graph - The compiled graph to extract schemas from
 * @returns GraphSchema if Zod schemas found in registry, undefined otherwise
 */
async function tryZodRegistryExtraction(
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
    return undefined;
  }
}

/**
 * Fallback: Try direct Zod conversion without registry.
 * Handles Zod schemas that weren't registered with withLangGraph().
 * Note: jsonSchemaExtra will NOT be included in this path.
 *
 * @param graph - The compiled graph to extract schemas from
 * @returns GraphSchema if Zod schemas found, undefined otherwise
 */
async function tryDirectZodExtraction(
  graph: Pregel<any, any, any, any, any>
): Promise<GraphSchema | undefined> {
  try {
    const { toJsonSchema } = await import("@langchain/core/utils/json_schema");
    const { isZodSchemaV3, isZodSchemaV4 } = await import(
      "@langchain/core/utils/types"
    );

    const builder = (graph as unknown as { builder?: GraphBuilder }).builder;
    if (!builder) return undefined;

    const extractSchema = (schema: unknown): JSONSchema7 | undefined => {
      if (!schema) return undefined;
      if (isZodSchemaV4(schema) || isZodSchemaV3(schema)) {
        try {
          return toJsonSchema(schema) as JSONSchema7;
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    const state = extractSchema(builder._schemaRuntimeDefinition);
    const input =
      extractSchema(builder._inputRuntimeDefinition) ??
      (state ? { ...state, required: undefined } : undefined);
    const output = extractSchema(builder._outputRuntimeDefinition);
    const config = extractSchema(builder._configRuntimeSchema);

    if (!state && !input && !output && !config) return undefined;
    return { state, input, output, config };
  } catch {
    return undefined;
  }
}

/**
 * Extract JSON schemas from a compiled graph at runtime.
 *
 * Uses a multi-tier extraction strategy:
 * 1. StateSchema - Native JSON schema via getJsonSchema() (handles jsonSchemaExtra)
 * 2. Zod Registry - Via schemaMetaRegistry (handles withLangGraph jsonSchemaExtra)
 * 3. Direct Zod - Fallback conversion without registry (no jsonSchemaExtra)
 * 4. Returns undefined to fall back to static TypeScript parser
 *
 * @param graph - The compiled Pregel graph to extract schemas from
 * @returns GraphSchema with state/input/output/config schemas, or undefined if extraction fails
 */
export async function getRuntimeGraphSchema(
  graph: Pregel<any, any, any, any, any>
): Promise<GraphSchema | undefined> {
  const builder = (graph as unknown as { builder?: GraphBuilder }).builder;
  if (!builder) return undefined;

  // Priority 1: StateSchema (handles jsonSchemaExtra via ReducedValue)
  const stateSchemaResult = await tryStateSchemaExtraction(graph);
  if (stateSchemaResult) return stateSchemaResult;

  // Priority 2: Zod via schemaMetaRegistry (handles jsonSchemaExtra from withLangGraph)
  const zodRegistryResult = await tryZodRegistryExtraction(graph);
  if (zodRegistryResult) return zodRegistryResult;

  // Priority 3: Direct Zod conversion (no jsonSchemaExtra, but better than nothing)
  const directZodResult = await tryDirectZodExtraction(graph);
  if (directZodResult) return directZodResult;

  // Priority 4: Fall through to static TypeScript parser
  return undefined;
}
