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

type RawZodObject = z.ZodObject<z.ZodRawShape>;

export type AnyZodObject =
  | RawZodObject
  | z.ZodIntersection<RawZodObject, RawZodObject>;

export function isZodType(value: unknown): value is z.ZodType {
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
  if (isZodObject(value)) {
    return true;
  }
  if (isZodObjectIntersection(value)) {
    return true;
  }
  return false;
}

/**
 * @internal
 */
export function isZodObject(
  value: unknown
): value is z.ZodObject<z.ZodRawShape> {
  if (!isZodType(value)) return false;
  if ("partial" in value && typeof value.partial === "function") {
    return true;
  }
  return true;
}

/**
 * @internal
 */
export function isZodObjectIntersection(
  value: unknown
): value is z.ZodIntersection<RawZodObject, RawZodObject> {
  if (!isZodType(value)) return false;
  const maybeDef = (value as { _def?: unknown })._def;
  if (
    !maybeDef ||
    typeof maybeDef !== "object" ||
    !("left" in maybeDef) ||
    !("right" in maybeDef)
  ) {
    return false;
  }
  const { left, right } = maybeDef as { left: unknown; right: unknown };
  return isAnyZodObject(left) && isAnyZodObject(right);
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

export type ZodToStateDefinition<T extends AnyZodObject> =
  // Handle ZodObject
  T extends z.ZodObject<infer Shape>
    ? {
        [K in keyof Shape]: Shape[K] extends z.ZodType<
          infer V,
          z.ZodTypeDef,
          infer U
        >
          ? BaseChannel<V, U>
          : never;
      }
    : // Handle ZodIntersection of two ZodObjects
    T extends z.ZodIntersection<infer Left, infer Right>
    ? ZodToStateDefinition<Left> & ZodToStateDefinition<Right>
    : never;

export function getChannelsFromZod<T extends AnyZodObject>(
  schema: T
): ZodToStateDefinition<T> {
  // Handle ZodObject
  if (isZodObject(schema)) {
    const channels = {} as Record<string, BaseChannel>;
    for (const key in schema.shape) {
      if (Object.prototype.hasOwnProperty.call(schema.shape, key)) {
        const keySchema = schema.shape[key];
        const meta = getMeta(keySchema);
        if (meta?.reducer) {
          type ValueType = z.infer<T>[typeof key];
          channels[key] = new BinaryOperatorAggregate<ValueType>(
            meta.reducer.fn,
            meta.default
          );
        } else {
          channels[key] = new LastValue();
        }
      }
    }
    return channels as ZodToStateDefinition<T>;
  }
  // Handle ZodIntersection of two ZodObjects
  if (isZodObjectIntersection(schema)) {
    // Recursively extract channels from both sides and merge
    const left = getChannelsFromZod(schema._def.left as AnyZodObject);
    const right = getChannelsFromZod(schema._def.right as AnyZodObject);
    return { ...left, ...right } as ZodToStateDefinition<T>;
  }
  return {} as ZodToStateDefinition<T>;
}
