import type { z } from "zod";
import { BaseChannel } from "../../channels/base.js";
import { BinaryOperatorAggregate } from "../../channels/binop.js";
import { LastValue } from "../../channels/last_value.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const META_MAP = new WeakMap<z.ZodType, Meta<any, any>>();

export interface Meta<ValueType, UpdateType = ValueType> {
  jsonSchemaExtra?: {
    langgraph_nodes?: string[];
    langgraph_type?: "prompt";

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

function isZodDefault(value: unknown): value is z.ZodDefault<z.ZodTypeAny> {
  return (
    isZodType(value) &&
    "removeDefault" in value &&
    typeof value.removeDefault === "function"
  );
}

export function isAnyZodObject(value: unknown): value is AnyZodObject {
  return (
    isZodType(value) &&
    "partial" in value &&
    typeof value.partial === "function"
  );
}

export function extra<ValueType, UpdateType = ValueType>(
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
