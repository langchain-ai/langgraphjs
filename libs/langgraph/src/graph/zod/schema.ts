import { z } from "zod";
import { zodToJsonSchema as _zodToJsonSchema } from "zod-to-json-schema";
import { getMeta } from "./state.js";

const TYPE_CACHE: Record<string, WeakMap<z.AnyZodObject, z.AnyZodObject>> = {};
const DESCRIPTION_PREFIX = "lg:";

function applyPlugin(
  schema: z.AnyZodObject,
  actions: {
    /** Apply .langgraph.reducer calls */
    reducer?: boolean;

    /** Apply .langgraph.metadata() calls  */
    jsonSchemaExtra?: boolean;

    /** Apply .partial() */
    partial?: boolean;
  }
) {
  const cacheKey = [
    `reducer:${actions.reducer ?? false}`,
    `jsonSchemaExtra:${actions.jsonSchemaExtra ?? false}`,
    `partial:${actions.partial ?? false}`,
  ].join("|");

  TYPE_CACHE[cacheKey] ??= new WeakMap();
  const cache = TYPE_CACHE[cacheKey];

  if (cache.has(schema)) return cache.get(schema)!;
  let shape = z.object({
    ...Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(
        ([key, input]): [string, z.ZodTypeAny] => {
          const meta = getMeta(input);
          let output = actions.reducer ? meta?.reducer?.schema ?? input : input;

          if (actions.jsonSchemaExtra) {
            const strMeta = JSON.stringify({
              ...meta?.jsonSchemaExtra,
              description: output.description ?? input.description,
            });

            if (strMeta !== "{}") {
              output = output.describe(`${DESCRIPTION_PREFIX}${strMeta}`);
            }
          }

          return [key, output];
        }
      )
    ),
  });

  if (actions.partial) shape = shape.partial();
  cache.set(schema, shape);
  return shape;
}

// Using a subset of types to avoid circular type import
interface GraphWithZodLike {
  builder: {
    _schemaRuntimeDefinition: z.AnyZodObject | undefined;
    _inputRuntimeDefinition: z.AnyZodObject | undefined;
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

type JsonSchema = ReturnType<typeof _zodToJsonSchema>;

function applyExtraFromDescription(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(applyExtraFromDescription);
  }

  if (typeof schema === "object" && schema != null) {
    const output = Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        applyExtraFromDescription(value),
      ])
    );

    if (
      "description" in output &&
      typeof output.description === "string" &&
      output.description.startsWith(DESCRIPTION_PREFIX)
    ) {
      const strMeta = output.description.slice(DESCRIPTION_PREFIX.length);
      delete output.description;
      Object.assign(output, JSON.parse(strMeta));
    }

    return output;
  }

  return schema as JsonSchema;
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
  return toJsonSchema(schemaDef);
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
    applyPlugin(schemaDef, {
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
  const schemaDef = graph.builder._inputRuntimeDefinition;
  if (!schemaDef) return undefined;
  return toJsonSchema(
    applyPlugin(schemaDef, {
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
  return toJsonSchema(applyPlugin(schemaDef, { jsonSchemaExtra: true }));
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
  return toJsonSchema(applyPlugin(configDef, { jsonSchemaExtra: true }));
}
