import type { z } from "zod";
import { zodToJsonSchema as _zodToJsonSchema } from "zod-to-json-schema";
import { applyZodPlugin, applyExtraFromDescription } from "./state.js";

const PartialStateSchema = Symbol.for("langgraph.state.partial");
type PartialStateSchema = typeof PartialStateSchema;
type JsonSchema = ReturnType<typeof _zodToJsonSchema>;

// Using a subset of types to avoid circular type import
interface GraphWithZodLike {
  builder: {
    _schemaRuntimeDefinition: z.AnyZodObject | undefined;
    _inputRuntimeDefinition: z.AnyZodObject | PartialStateSchema | undefined;
    _outputRuntimeDefinition: z.AnyZodObject | undefined;
    _configRuntimeSchema: z.AnyZodObject | undefined;
  };
}

function isGraphWithZodLike(graph: unknown): graph is GraphWithZodLike {
  if (!graph || typeof graph !== "object") return false;
  if (
    !("builder" in graph) ||
    typeof graph.builder !== "object" ||
    graph.builder == null
  ) {
    return false;
  }

  return true;
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return applyExtraFromDescription(_zodToJsonSchema(schema)) as JsonSchema;
}

/**
 * Get the state schema for a graph.
 * @param graph - The graph to get the state schema for.
 * @returns The state schema for the graph.
 */
export function getStateTypeSchema(graph: unknown): JsonSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._schemaRuntimeDefinition;
  if (!schemaDef) return undefined;
  return toJsonSchema(applyZodPlugin(schemaDef, { jsonSchemaExtra: true }));
}

/**
 * Get the update schema for a graph.
 * @param graph - The graph to get the update schema for.
 * @returns The update schema for the graph.
 */
export function getUpdateTypeSchema(graph: unknown): JsonSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._schemaRuntimeDefinition;
  if (!schemaDef) return undefined;

  return toJsonSchema(
    applyZodPlugin(schemaDef, {
      reducer: true,
      jsonSchemaExtra: true,
      partial: true,
    })
  );
}

/**
 * Get the input schema for a graph.
 * @param graph - The graph to get the input schema for.
 * @returns The input schema for the graph.
 */
export function getInputTypeSchema(graph: unknown): JsonSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  let schemaDef = graph.builder._inputRuntimeDefinition;
  if (schemaDef === PartialStateSchema) {
    // No need to pass `.partial()` here, that's being done by `applyPlugin`
    schemaDef = graph.builder._schemaRuntimeDefinition;
  }

  if (!schemaDef) return undefined;
  return toJsonSchema(
    applyZodPlugin(schemaDef, {
      reducer: true,
      jsonSchemaExtra: true,
      partial: true,
    })
  );
}

/**
 * Get the output schema for a graph.
 * @param graph - The graph to get the output schema for.
 * @returns The output schema for the graph.
 */
export function getOutputTypeSchema(graph: unknown): JsonSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._outputRuntimeDefinition;
  if (!schemaDef) return undefined;
  return toJsonSchema(applyZodPlugin(schemaDef, { jsonSchemaExtra: true }));
}

/**
 * Get the config schema for a graph.
 * @param graph - The graph to get the config schema for.
 * @returns The config schema for the graph.
 */
export function getConfigTypeSchema(graph: unknown): JsonSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const configDef = graph.builder._configRuntimeSchema;
  if (!configDef) return undefined;
  return toJsonSchema(applyZodPlugin(configDef, { jsonSchemaExtra: true }));
}
