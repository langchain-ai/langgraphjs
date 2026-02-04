import {
  InferInteropZodOutput,
  InteropZodObject,
  InteropZodType,
  getInteropZodObjectShape,
  extendInteropZodObject,
  getInteropZodDefaultGetter,
  interopZodObjectPartial,
  InteropZodObjectShape,
  isZodSchemaV3,
  getSchemaDescription,
} from "@langchain/core/utils/types";
import { BaseChannel } from "../../channels/base.js";
import { BinaryOperatorAggregate } from "../../channels/binop.js";
import { LastValue } from "../../channels/last_value.js";

export const META_EXTRAS_DESCRIPTION_PREFIX = "lg:";

/** @internal */
export type ReducedZodChannel<
  T extends InteropZodType,
  TReducerSchema extends InteropZodType
> = T & {
  lg_reducer_schema: TReducerSchema;
};

/** @internal */
export type InteropZodToStateDefinition<
  T extends InteropZodObject,
  TShape = InteropZodObjectShape<T>
> = {
  [key in keyof TShape]: TShape[key] extends ReducedZodChannel<
    infer Schema,
    infer ReducerSchema
  >
    ? Schema extends InteropZodType<infer V>
      ? ReducerSchema extends InteropZodType<infer U>
        ? BaseChannel<V, U>
        : never
      : never
    : TShape[key] extends InteropZodType<infer V, infer U>
    ? BaseChannel<V, U>
    : never;
};

export type UpdateType<
  T extends InteropZodObject,
  TShape = InteropZodObjectShape<T>
> = {
  [key in keyof TShape]?: TShape[key] extends ReducedZodChannel<
    infer Schema,
    infer ReducerSchema
  >
    ? Schema extends InteropZodType<unknown>
      ? ReducerSchema extends InteropZodType<infer U>
        ? U
        : never
      : never
    : TShape[key] extends InteropZodType<unknown, infer U>
    ? U
    : never;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SchemaMeta<TValue = any, TUpdate = TValue> {
  jsonSchemaExtra?: {
    langgraph_nodes?: string[];
    langgraph_type?: "prompt" | "messages";
    [key: string]: unknown;
  };
  reducer?: {
    schema?: InteropZodType<TUpdate>;
    fn: (a: TValue, b: TUpdate) => TValue;
  };
  default?: () => TValue;
}

/**
 * A registry for storing and managing metadata associated with schemas.
 * This class provides methods to get, extend, remove, and check metadata for a given schema.
 */
export class SchemaMetaRegistry {
  /**
   * Internal map storing schema metadata.
   * @internal
   */
  _map = new Map<InteropZodType, SchemaMeta>();

  /**
   * Cache for extended schemas.
   * @internal
   */
  _extensionCache = new Map<string, Map<InteropZodType, InteropZodType>>();

  /**
   * Retrieves the metadata associated with a given schema.
   * @template TValue The value type of the schema.
   * @template TUpdate The update type of the schema (defaults to TValue).
   * @param schema The schema to retrieve metadata for.
   * @returns The associated SchemaMeta, or undefined if not present.
   */
  get<TValue, TUpdate = TValue>(
    schema: InteropZodType<TValue>
  ): SchemaMeta<TValue, TUpdate> | undefined {
    return this._map.get(schema);
  }

  /**
   * Extends or sets the metadata for a given schema.
   * @template TValue The value type of the schema.
   * @template TUpdate The update type of the schema (defaults to TValue).
   * @param schema The schema to extend metadata for.
   * @param predicate A function that receives the existing metadata (or undefined) and returns the new metadata.
   */
  extend<TValue, TUpdate>(
    schema: InteropZodType<TValue>,
    predicate: (
      meta: SchemaMeta<TValue, TUpdate> | undefined
    ) => SchemaMeta<TValue, TUpdate>
  ) {
    const existingMeta = this.get<TValue, TUpdate>(schema);
    this._map.set(schema, predicate(existingMeta));
  }

  /**
   * Removes the metadata associated with a given schema.
   * @param schema The schema to remove metadata for.
   * @returns The SchemaMetaRegistry instance (for chaining).
   */
  remove(schema: InteropZodType): this {
    this._map.delete(schema);
    return this;
  }

  /**
   * Checks if metadata exists for a given schema.
   * @param schema The schema to check.
   * @returns True if metadata exists, false otherwise.
   */
  has(schema: InteropZodType): boolean {
    return this._map.has(schema);
  }

  /**
   * Returns a mapping of channel instances for each property in the schema
   * using the associated metadata in the registry.
   *
   * This is used to create the `channels` object that's passed to the `Graph` constructor.
   *
   * @template T The shape of the schema.
   * @param schema The schema to extract channels from.
   * @returns A mapping from property names to channel instances.
   */
  getChannelsForSchema<T extends InteropZodObject>(
    schema: T
  ): InteropZodToStateDefinition<T> {
    const channels = {} as Record<string, BaseChannel>;
    const shape = getInteropZodObjectShape(schema);
    for (const [key, channelSchema] of Object.entries(shape)) {
      const meta = this.get(channelSchema);
      if (meta?.reducer) {
        channels[key] = new BinaryOperatorAggregate<
          InferInteropZodOutput<typeof channelSchema>
        >(meta.reducer.fn, meta.default);
      } else {
        channels[key] = new LastValue(meta?.default);
      }
    }
    return channels as InteropZodToStateDefinition<T>;
  }

  /**
   * Returns a modified schema that introspectively looks at all keys of the provided
   * object schema, and applies the augmentations based on meta provided with those keys
   * in the registry and the selectors provided in the `effects` parameter.
   *
   * This assumes that the passed in schema is the "root" schema object for a graph where
   * the keys of the schema are the channels of the graph. Because we need to represent
   * the input of a graph in a couple of different ways, the `effects` parameter allows
   * us to apply those augmentations based on pre determined conditions.
   *
   * @param schema The root schema object to extend.
   * @param effects The effects that are being applied.
   * @returns The extended schema.
   */
  getExtendedChannelSchemas<T extends InteropZodObject>(
    schema: T,
    effects: {
      /**
       * Augments the shape by using the reducer's schema if it exists
       */
      withReducerSchema?: boolean;
      /**
       * Applies the stringified jsonSchemaExtra as a description to the schema.
       */
      withJsonSchemaExtrasAsDescription?: boolean;
      /**
       * Applies the `.partial()` modifier to the schema.
       */
      asPartial?: boolean;
    }
  ): InteropZodObject {
    // If no effects are being applied, return the schema unchanged
    if (Object.keys(effects).length === 0) {
      return schema;
    }

    // Cache key is determined by looking at the effects that are being applied
    const cacheKey = Object.entries(effects)
      .filter(([, v]) => v === true)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join("|");

    const cache = this._extensionCache.get(cacheKey) ?? new Map();
    if (cache.has(schema)) return cache.get(schema)! as T;

    let modifiedSchema: InteropZodObject = schema;

    if (
      effects.withReducerSchema ||
      effects.withJsonSchemaExtrasAsDescription
    ) {
      const newShapeEntries = Object.entries(
        getInteropZodObjectShape(schema)
      ).map(([key, schema]) => {
        const meta = this.get(schema);
        let outputSchema = effects.withReducerSchema
          ? meta?.reducer?.schema ?? schema
          : schema;
        if (
          effects.withJsonSchemaExtrasAsDescription &&
          meta?.jsonSchemaExtra
        ) {
          const description =
            getSchemaDescription(outputSchema) ?? getSchemaDescription(schema);
          const strExtras = JSON.stringify({
            ...meta.jsonSchemaExtra,
            description,
          });
          outputSchema = outputSchema.describe(
            `${META_EXTRAS_DESCRIPTION_PREFIX}${strExtras}`
          );
        }
        return [key, outputSchema];
      });
      modifiedSchema = extendInteropZodObject(
        schema,
        Object.fromEntries(newShapeEntries)
      );
      if (isZodSchemaV3(modifiedSchema)) {
        modifiedSchema._def.unknownKeys = "strip";
      }
    }
    if (effects.asPartial) {
      modifiedSchema = interopZodObjectPartial(modifiedSchema);
    }

    cache.set(schema, modifiedSchema);
    this._extensionCache.set(cacheKey, cache);
    return modifiedSchema;
  }
}

export const schemaMetaRegistry = new SchemaMetaRegistry();

export function withLangGraph<
  TValue,
  TUpdate,
  TSchema extends InteropZodType<TValue>
>(
  schema: TSchema,
  meta: SchemaMeta<TValue, TUpdate> & { reducer?: undefined }
): TSchema;
export function withLangGraph<
  TValue,
  TUpdate,
  TSchema extends InteropZodType<TValue>
>(
  schema: TSchema,
  meta: SchemaMeta<TValue, TUpdate>
): ReducedZodChannel<TSchema, InteropZodType<TUpdate>>;
export function withLangGraph<
  TValue,
  TUpdate,
  TSchema extends InteropZodType<TValue>
>(
  schema: TSchema,
  meta: SchemaMeta<TValue, TUpdate>
): ReducedZodChannel<TSchema, InteropZodType<TUpdate>> | TSchema {
  if (meta.reducer && !meta.default) {
    const defaultValueGetter = getInteropZodDefaultGetter(schema);
    if (defaultValueGetter != null) {
      // eslint-disable-next-line no-param-reassign
      meta.default = defaultValueGetter;
    }
  }
  if (meta.reducer) {
    const schemaWithReducer = Object.assign(schema, {
      lg_reducer_schema: meta.reducer?.schema ?? schema,
    });
    schemaMetaRegistry.extend(schemaWithReducer, () => meta);
    return schemaWithReducer;
  } else {
    schemaMetaRegistry.extend(schema, () => meta);
    return schema;
  }
}
