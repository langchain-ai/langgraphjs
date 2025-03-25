import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getMeta } from "./state.js";

const UPDATE_TYPE_CACHE = new WeakMap<z.AnyZodObject, z.AnyZodObject>();
const DESCRIPTION_PREFIX = "lg:";

export function getUpdateTypeSchema(shape: z.AnyZodObject) {
  const updateSchema = (() => {
    if (UPDATE_TYPE_CACHE.has(shape)) UPDATE_TYPE_CACHE.get(shape);

    const newSchema = z.object({
      ...Object.fromEntries(
        Object.entries(shape.shape as Record<string, z.ZodTypeAny>).map(
          ([key, value]): [string, z.ZodTypeAny] => {
            const meta = getMeta(value);
            let finalSchema = meta?.reducer?.schema ?? value;

            finalSchema = finalSchema.describe(
              `${DESCRIPTION_PREFIX}${JSON.stringify({
                ...meta?.jsonSchemaExtra,
                description: finalSchema.description ?? value.description,
              })}`
            );

            return [key, finalSchema];
          }
        )
      ),
    });

    UPDATE_TYPE_CACHE.set(shape, newSchema);
    return newSchema;
  })();

  const schema = zodToJsonSchema(updateSchema);

  const findAndReplaceSchema = (schema: unknown): unknown => {
    if (Array.isArray(schema)) {
      return schema.map(findAndReplaceSchema);
    }

    if (typeof schema === "object" && schema != null) {
      const output = Object.fromEntries(
        Object.entries(schema).map(([key, value]) => [
          key,
          findAndReplaceSchema(value),
        ])
      );

      if (
        "description" in output &&
        typeof output.description === "string" &&
        output.description.startsWith(DESCRIPTION_PREFIX)
      ) {
        Object.assign(
          output,
          JSON.parse(output.description.slice(DESCRIPTION_PREFIX.length))
        );

        if (output.description == null) delete output.description;
      }

      return output;
    }

    return schema;
  };
  return findAndReplaceSchema(schema);
}

export function getConfigTypeSchema(schema: z.AnyZodObject) {
  return getUpdateTypeSchema(schema);
}

export function getStateTypeSchema(schema: z.AnyZodObject) {
  return zodToJsonSchema(schema);
}
