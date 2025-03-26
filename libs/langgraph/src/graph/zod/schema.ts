import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getMeta } from "./state.js";

const UPDATE_TYPE_CACHE = new WeakMap<z.AnyZodObject, z.AnyZodObject>();
const CONFIG_TYPE_CACHE = new WeakMap<z.AnyZodObject, z.AnyZodObject>();

const DESCRIPTION_PREFIX = "lg:";

function applyPlugin(
  schema: z.AnyZodObject,
  actions: { reducer?: boolean; jsonSchemaExtra?: boolean }
) {
  return z.object({
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
}

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

  return schema;
}

export function getUpdateTypeSchema(shape: z.AnyZodObject) {
  const updateShape = (() => {
    if (UPDATE_TYPE_CACHE.has(shape)) UPDATE_TYPE_CACHE.get(shape);

    const newShape = applyPlugin(shape, {
      reducer: true,
      jsonSchemaExtra: true,
    }).partial();

    UPDATE_TYPE_CACHE.set(shape, newShape);
    return newShape;
  })();

  const schema = zodToJsonSchema(updateShape);
  return applyExtraFromDescription(schema);
}

export function getConfigTypeSchema(shape: z.AnyZodObject) {
  const configShape = (() => {
    if (CONFIG_TYPE_CACHE.has(shape)) CONFIG_TYPE_CACHE.get(shape);
    const newShape = applyPlugin(shape, { jsonSchemaExtra: true });
    CONFIG_TYPE_CACHE.set(shape, newShape);
    return newShape;
  })();

  const schema = zodToJsonSchema(configShape);
  return applyExtraFromDescription(schema);
}

export function getStateTypeSchema(schema: z.AnyZodObject) {
  return zodToJsonSchema(schema);
}
