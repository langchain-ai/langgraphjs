import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getMeta } from "./state.js";

const UPDATE_TYPE_CACHE = new WeakMap<z.AnyZodObject, z.AnyZodObject>();

export function getUpdateTypeSchema(schema: z.AnyZodObject) {
  const updateSchema = (() => {
    if (UPDATE_TYPE_CACHE.has(schema)) UPDATE_TYPE_CACHE.get(schema);

    const newSchema = z.object({
      ...Object.fromEntries(
        Object.entries(schema.shape as Record<string, z.ZodTypeAny>).map(
          ([key, value]): [string, z.ZodTypeAny] => [
            key,
            getMeta(value)?.reducer?.schema ?? value,
          ]
        )
      ),
    });

    UPDATE_TYPE_CACHE.set(schema, newSchema);
    return newSchema;
  })();

  return zodToJsonSchema(updateSchema);
}

export function getStateTypeSchema(schema: z.AnyZodObject) {
  return zodToJsonSchema(schema);
}
