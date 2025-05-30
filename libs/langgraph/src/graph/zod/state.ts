import type { z } from "zod";
import { BaseChannel } from "../../channels/base.js";
import { BinaryOperatorAggregate } from "../../channels/binop.js";
import { LastValue } from "../../channels/last_value.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const META_MAP = new WeakMap<z.ZodType, Meta<any, any>>();

export interface Meta<ValueType, UpdateType = ValueType> {
  jsonSchemaExtra?: {
    langgraph_nodes?: string[];
    langgraph_type?: "prompt" | "messages";

    [key: string]: unknown;
  };
  reducer?: {
    schema?: z.ZodType<UpdateType>;
    fn: (a: ValueType, b: UpdateType) => ValueType;
  };
  default?: () => ValueType;
}

export type AnyZodObject = z.ZodObject<z.ZodRawShape>;

function isZodType(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value != null &&
    "_parse" in value &&
    typeof value._parse === "function"
  );
}

/**
 * @internal
 */
export function isZodDefault(
  value: unknown
): value is z.ZodDefault<z.ZodTypeAny> {
  return (
    isZodType(value) &&
    "removeDefault" in value &&
    typeof value.removeDefault === "function"
  );
}

/**
 * @internal
 */
export function isAnyZodObject(value: unknown): value is AnyZodObject {
  return (
    isZodType(value) &&
    "partial" in value &&
    typeof value.partial === "function"
  );
}

export function withLangGraph<ValueType, UpdateType = ValueType>(
  schema: z.ZodType<ValueType | undefined>,
  meta: Meta<ValueType, UpdateType>
): z.ZodType<ValueType, z.ZodTypeDef, UpdateType> {
  if (meta.reducer && !meta.default) {
    const defaultValue = isZodDefault(schema)
      ? schema._def.defaultValue
      : undefined;

    if (defaultValue != null) {
      // eslint-disable-next-line no-param-reassign
      meta.default = defaultValue;
    }
  }
  META_MAP.set(schema, meta);
  return schema as z.ZodType<ValueType, z.ZodTypeDef, UpdateType>;
}

export function getMeta<ValueType, UpdateType = ValueType>(
  schema: z.ZodType<ValueType>
): Meta<ValueType, UpdateType> | undefined {
  return META_MAP.get(schema);
}

export function extendMeta<ValueType, UpdateType = ValueType>(
  schema: z.ZodType<ValueType>,
  update: (
    meta: Meta<ValueType, UpdateType> | undefined
  ) => Meta<ValueType, UpdateType>
): void {
  const existingMeta = getMeta(schema) as
    | Meta<ValueType, UpdateType>
    | undefined;
  const newMeta = update(existingMeta);
  META_MAP.set(schema, newMeta);
}

export type ZodToStateDefinition<T extends AnyZodObject> = {
  [key in keyof T["shape"]]: T["shape"][key] extends z.ZodType<
    infer V,
    z.ZodTypeDef,
    infer U
  >
    ? BaseChannel<V, U>
    : never;
};

export function getChannelsFromZod<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>
): ZodToStateDefinition<z.ZodObject<T>> {
  const channels = {} as Record<string, BaseChannel>;
  for (const key in schema.shape) {
    if (Object.prototype.hasOwnProperty.call(schema.shape, key)) {
      const keySchema = schema.shape[key];
      const meta = getMeta(keySchema);
      if (meta?.reducer) {
        channels[key] = new BinaryOperatorAggregate<z.infer<T[typeof key]>>(
          meta.reducer.fn,
          meta.default
        );
      } else {
        channels[key] = new LastValue();
      }
    }
  }
  return channels as ZodToStateDefinition<z.ZodObject<T>>;
}

const ZOD_TYPE_CACHE: Record<
  string,
  WeakMap<z.AnyZodObject, z.AnyZodObject>
> = {};

const ZOD_DESCRIPTION_PREFIX = "lg:";

export function applyZodPlugin(
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

  ZOD_TYPE_CACHE[cacheKey] ??= new WeakMap();
  const cache = ZOD_TYPE_CACHE[cacheKey];

  if (cache.has(schema)) return cache.get(schema)!;

  let shape = schema.extend({
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
              output = output.describe(`${ZOD_DESCRIPTION_PREFIX}${strMeta}`);
            }
          }

          return [key, output];
        }
      )
    ),
  });

  // using zObject.extend() will set `unknownKeys` to `passthrough`
  // which trips up `zod-to-json-schema`
  if (
    "_def" in shape &&
    shape._def != null &&
    typeof shape._def === "object" &&
    "unknownKeys" in shape._def
  ) {
    shape._def.unknownKeys = "strip";
  }

  if (actions.partial) shape = shape.partial();
  cache.set(schema, shape);
  return shape;
}

export function applyExtraFromDescription(schema: unknown): unknown {
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
      output.description.startsWith(ZOD_DESCRIPTION_PREFIX)
    ) {
      const strMeta = output.description.slice(ZOD_DESCRIPTION_PREFIX.length);
      delete output.description;
      Object.assign(output, JSON.parse(strMeta));
    }

    return output;
  }

  return schema;
}
