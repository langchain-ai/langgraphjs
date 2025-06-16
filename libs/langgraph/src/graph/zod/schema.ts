import {
  type JSONSchema,
  toJsonSchema as interopToJsonSchema,
} from "@langchain/core/utils/json_schema";
import { InteropZodObject } from "@langchain/core/utils/types";
import {
  META_EXTRAS_DESCRIPTION_PREFIX,
  SchemaMetaRegistry,
  schemaMetaRegistry,
} from "./meta.js";

const PartialStateSchema = Symbol.for("langgraph.state.partial");
type PartialStateSchema = typeof PartialStateSchema;

interface GraphWithZodLike {
  builder: {
    _schemaRuntimeDefinition: InteropZodObject | undefined;
    _inputRuntimeDefinition: InteropZodObject | PartialStateSchema | undefined;
    _outputRuntimeDefinition: InteropZodObject | undefined;
    _configRuntimeSchema: InteropZodObject | undefined;
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

function applyJsonSchemaExtrasFromDescription<T>(schema: T): unknown {
  if (Array.isArray(schema)) {
    return schema.map(applyJsonSchemaExtrasFromDescription);
  }
  if (typeof schema === "object" && schema != null) {
    const output = Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        applyJsonSchemaExtrasFromDescription(value),
      ])
    );

    if (
      "description" in output &&
      typeof output.description === "string" &&
      output.description.startsWith(META_EXTRAS_DESCRIPTION_PREFIX)
    ) {
      const strMeta = output.description.slice(
        META_EXTRAS_DESCRIPTION_PREFIX.length
      );
      delete output.description;
      Object.assign(output, JSON.parse(strMeta));
    }

    return output as T;
  }
  return schema;
}

function toJsonSchema(schema: InteropZodObject): JSONSchema {
  return applyJsonSchemaExtrasFromDescription(
    interopToJsonSchema(schema)
  ) as JSONSchema;
}

/**
 * Get the state schema for a graph.
 * @param graph - The graph to get the state schema for.
 * @returns The state schema for the graph.
 */
export function getStateTypeSchema(
  graph: unknown,
  registry: SchemaMetaRegistry = schemaMetaRegistry
): JSONSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._schemaRuntimeDefinition;
  if (!schemaDef) return undefined;

  return toJsonSchema(
    registry.getExtendedChannelSchemas(schemaDef, {
      withJsonSchemaExtrasAsDescription: true,
    })
  );
}

/**
 * Get the update schema for a graph.
 * @param graph - The graph to get the update schema for.
 * @returns The update schema for the graph.
 */
export function getUpdateTypeSchema(
  graph: unknown,
  registry: SchemaMetaRegistry = schemaMetaRegistry
): JSONSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._schemaRuntimeDefinition;
  if (!schemaDef) return undefined;

  return toJsonSchema(
    registry.getExtendedChannelSchemas(schemaDef, {
      withReducerSchema: true,
      withJsonSchemaExtrasAsDescription: true,
      asPartial: true,
    })
  );
}

/**
 * Get the input schema for a graph.
 * @param graph - The graph to get the input schema for.
 * @returns The input schema for the graph.
 */
export function getInputTypeSchema(
  graph: unknown,
  registry: SchemaMetaRegistry = schemaMetaRegistry
): JSONSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  let schemaDef = graph.builder._inputRuntimeDefinition;
  if (schemaDef === PartialStateSchema) {
    // No need to pass `.partial()` here, that's being done by `applyPlugin`
    schemaDef = graph.builder._schemaRuntimeDefinition;
  }
  if (!schemaDef) return undefined;

  return toJsonSchema(
    registry.getExtendedChannelSchemas(schemaDef, {
      withReducerSchema: true,
      withJsonSchemaExtrasAsDescription: true,
      asPartial: true,
    })
  );
}

/**
 * Get the output schema for a graph.
 * @param graph - The graph to get the output schema for.
 * @returns The output schema for the graph.
 */
export function getOutputTypeSchema(
  graph: unknown,
  registry: SchemaMetaRegistry = schemaMetaRegistry
): JSONSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const schemaDef = graph.builder._outputRuntimeDefinition;
  if (!schemaDef) return undefined;

  return toJsonSchema(
    registry.getExtendedChannelSchemas(schemaDef, {
      withJsonSchemaExtrasAsDescription: true,
    })
  );
}

/**
 * Get the config schema for a graph.
 * @param graph - The graph to get the config schema for.
 * @returns The config schema for the graph.
 */
export function getConfigTypeSchema(
  graph: unknown,
  registry: SchemaMetaRegistry = schemaMetaRegistry
): JSONSchema | undefined {
  if (!isGraphWithZodLike(graph)) return undefined;
  const configDef = graph.builder._configRuntimeSchema;
  if (!configDef) return undefined;

  return toJsonSchema(
    registry.getExtendedChannelSchemas(configDef, {
      withJsonSchemaExtrasAsDescription: true,
    })
  );
}
