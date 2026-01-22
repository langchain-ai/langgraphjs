/* eslint-disable @typescript-eslint/no-explicit-any */
import type { JSONSchema } from "@langchain/core/utils/json_schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { RunnableLike } from "../pregel/runnable_types.js";
import {
  BaseChannel,
  LastValue,
  BinaryOperatorAggregate,
} from "../channels/index.js";
import { UntrackedValueChannel } from "../channels/untracked_value.js";

import type { SerializableSchema } from "./types.js";
import { isStandardSchema } from "./types.js";
import { getJsonSchemaFromSchema, getSchemaDefaultGetter } from "./adapter.js";
import { ReducedValue } from "./values/reduced.js";
import { UntrackedValue } from "./values/untracked.js";

const STATE_SCHEMA_SYMBOL = Symbol.for("langgraph.state.state_schema");

/**
 * Maps a single StateSchema field definition to its corresponding Channel type.
 *
 * This utility type inspects the type of the field and returns an appropriate
 * `BaseChannel` type, parameterized with the state "value" and "input" types according to the field's shape.
 *
 * Rules:
 * - If the field (`F`) is a `ReducedValue<V, I>`, the channel will store values of type `V`
 *   and accept input of type `I`.
 * - If the field is a `UntrackedValue<V>`, the channel will store and accept values of type `V`.
 * - If the field is a `SerializableSchema<I, O>`, the channel will store values of type `O`
 *   (the schema's output/validated value) and accept input of type `I`.
 * - For all other types, a generic `BaseChannel<unknown, unknown>` is used as fallback.
 *
 * @template F - The StateSchema field type to map to a Channel type.
 *
 * @example
 * ```typescript
 * type MyField = ReducedValue<number, string>;
 * type ChannelType = StateSchemaFieldToChannel<MyField>;
 * // ChannelType is BaseChannel<number, string>
 * ```
 */
export type StateSchemaFieldToChannel<F> = F extends ReducedValue<
  infer V,
  infer I
>
  ? BaseChannel<V, I>
  : F extends UntrackedValue<infer V>
  ? BaseChannel<V, V>
  : F extends SerializableSchema<infer I, infer O>
  ? BaseChannel<O, I>
  : BaseChannel<unknown, unknown>;

/**
 * Converts StateSchema fields into a strongly-typed
 * State Definition object, where each field is mapped to its channel type.
 *
 * This utility type is used internally to create the shape of the state channels for a given schema,
 * substituting each field with the result of `StateSchemaFieldToChannel`.
 *
 * If you define a state schema as:
 * ```typescript
 * const fields = {
 *   a: ReducedValue<number, string>(),
 *   b: UntrackedValue<boolean>(),
 *   c: SomeSerializableSchemaType, // SerializableSchema<in, out>
 * }
 * ```
 * then `StateSchemaFieldsToStateDefinition<typeof fields>` yields:
 * ```typescript
 * {
 *   a: BaseChannel<number, string>;
 *   b: BaseChannel<boolean, boolean>;
 *   c: BaseChannel<typeof schema's output type, typeof schema's input type>;
 * }
 * ```
 *
 * @template TFields - The mapping of field names to StateSchema field types.
 * @returns An object type mapping field names to channel types.
 *
 * @see StateSchemaFieldToChannel
 */
export type StateSchemaFieldsToStateDefinition<
  TFields extends StateSchemaFields
> = {
  [K in keyof TFields]: StateSchemaFieldToChannel<TFields[K]>;
};

/**
 * Valid field types for StateSchema.
 * Either a LangGraph state value type or a raw schema (e.g., Zod schema).
 */
export type StateSchemaField<Input = unknown, Output = Input> =
  | ReducedValue<Input, Output>
  | UntrackedValue<Output>
  | SerializableSchema<Input, Output>;

/**
 * Init object for StateSchema constructor.
 * Uses `any` to allow variance in generic types (e.g., ReducedValue<string, string[]>).
 */
export type StateSchemaFields = {
  [key: string]: StateSchemaField<any, any>;
};

/**
 * Infer the State type from a StateSchemaFields.
 * This is the type of the full state object.
 *
 * - ReducedValue<Value, Input> → Value (the stored type)
 * - UntrackedValue<Value> → Value
 * - SerializableSchema<Input, Output> → Output (the validated type)
 */
export type InferStateSchemaValue<TFields extends StateSchemaFields> = {
  [K in keyof TFields]: TFields[K] extends ReducedValue<any, any>
    ? TFields[K]["ValueType"]
    : TFields[K] extends UntrackedValue<any>
    ? TFields[K]["ValueType"]
    : TFields[K] extends SerializableSchema<any, infer TOutput>
    ? TOutput
    : never;
};

/**
 * Infer the Update type from a StateSchemaFields.
 * This is the type for partial updates to state.
 *
 * - ReducedValue<Value, Input> → Input (the reducer input type)
 * - UntrackedValue<Value> → Value
 * - SerializableSchema<Input, Output> → Input (what you provide)
 */
export type InferStateSchemaUpdate<TFields extends StateSchemaFields> = {
  [K in keyof TFields]?: TFields[K] extends ReducedValue<any, any>
    ? TFields[K]["InputType"]
    : TFields[K] extends UntrackedValue<any>
    ? TFields[K]["ValueType"]
    : TFields[K] extends SerializableSchema<infer TInput, any>
    ? TInput
    : never;
};

/**
 * StateSchema provides a unified API for defining LangGraph state schemas.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { StateSchema, ReducedValue, MessagesValue } from "@langchain/langgraph";
 *
 * const AgentState = new StateSchema({
 *   // Prebuilt messages value
 *   messages: MessagesValue,
 *   // Basic LastValue channel from any standard schema
 *   currentStep: z.string(),
 *   // LastValue with native default
 *   count: z.number().default(0),
 *   // ReducedValue for fields needing reducers
 *   history: new ReducedValue(
 *     z.array(z.string()).default(() => []),
 *     {
 *       inputSchema: z.string(),
 *       reducer: (current, next) => [...current, next],
 *     }
 *   ),
 * });
 *
 * // Extract types
 * type State = typeof AgentState.State;
 * type Update = typeof AgentState.Update;
 *
 * // Use in StateGraph
 * const graph = new StateGraph(AgentState);
 * ```
 */
export class StateSchema<TFields extends StateSchemaFields> {
  /**
   * Symbol for runtime identification.
   * @internal Used by isInstance for runtime type checking
   */
  // @ts-expect-error - Symbol is read via `in` operator in isInstance
  private readonly [STATE_SCHEMA_SYMBOL] = true;

  /**
   * Type declaration for the full state type.
   * Use: `typeof myState.State`
   */
  declare State: InferStateSchemaValue<TFields>;

  /**
   * Type declaration for the update type.
   * Use: `typeof myState.Update`
   */
  declare Update: InferStateSchemaUpdate<TFields>;

  /**
   * Type declaration for node functions.
   * Use: `typeof myState.Node` to type node functions outside the graph builder.
   *
   * @example
   * ```typescript
   * const AgentState = new StateSchema({
   *   count: z.number().default(0),
   * });
   *
   * const myNode: typeof AgentState.Node = (state) => {
   *   return { count: state.count + 1 };
   * };
   * ```
   */
  declare Node: RunnableLike<
    InferStateSchemaValue<TFields>,
    InferStateSchemaUpdate<TFields>
  >;

  constructor(readonly fields: TFields) {}

  /**
   * Get the channel definitions for use with StateGraph.
   * This converts the StateSchema fields into BaseChannel instances.
   */
  getChannels(): Record<string, BaseChannel> {
    const channels: Record<string, BaseChannel> = {};

    for (const [key, value] of Object.entries(this.fields)) {
      if (ReducedValue.isInstance(value)) {
        // ReducedValue -> BinaryOperatorAggregate
        const defaultGetter = getSchemaDefaultGetter(value.valueSchema);
        channels[key] = new BinaryOperatorAggregate(
          value.reducer,
          defaultGetter
        );
      } else if (UntrackedValue.isInstance(value)) {
        // UntrackedValue -> UntrackedValueChannel
        const defaultGetter = value.schema
          ? getSchemaDefaultGetter(value.schema)
          : undefined;
        channels[key] = new UntrackedValueChannel({
          guard: value.guard,
          initialValueFactory: defaultGetter,
        });
      } else if (isStandardSchema(value)) {
        // Plain schema -> LastValue channel
        const defaultGetter = getSchemaDefaultGetter(value);
        channels[key] = new LastValue(defaultGetter);
      } else {
        throw new Error(
          `Invalid state field "${key}": must be a schema, ReducedValue, UntrackedValue, or ManagedValue`
        );
      }
    }

    return channels;
  }

  /**
   * Get the JSON schema for the full state type.
   * Used by Studio and API for schema introspection.
   */
  getJsonSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(this.fields)) {
      let fieldSchema: JSONSchema | undefined;

      if (ReducedValue.isInstance(value)) {
        fieldSchema = getJsonSchemaFromSchema(value.valueSchema) as JSONSchema;
        if (fieldSchema && value.jsonSchemaExtra) {
          fieldSchema = { ...fieldSchema, ...value.jsonSchemaExtra };
        }
      } else if (UntrackedValue.isInstance(value)) {
        fieldSchema = value.schema
          ? (getJsonSchemaFromSchema(value.schema) as JSONSchema)
          : undefined;
      } else if (isStandardSchema(value)) {
        fieldSchema = getJsonSchemaFromSchema(value) as JSONSchema;
      }

      if (fieldSchema) {
        properties[key] = fieldSchema;

        // Field is required if it doesn't have a default
        let hasDefault = false;
        if (ReducedValue.isInstance(value)) {
          hasDefault = getSchemaDefaultGetter(value.valueSchema) !== undefined;
        } else if (UntrackedValue.isInstance(value)) {
          hasDefault = value.schema
            ? getSchemaDefaultGetter(value.schema) !== undefined
            : false;
        } else {
          hasDefault = getSchemaDefaultGetter(value) !== undefined;
        }

        if (!hasDefault) {
          required.push(key);
        }
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  /**
   * Get the JSON schema for the update/input type.
   * All fields are optional in updates.
   */
  getInputJsonSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = {};

    for (const [key, value] of Object.entries(this.fields)) {
      let fieldSchema: JSONSchema | undefined;

      if (ReducedValue.isInstance(value)) {
        // Use input schema for updates
        fieldSchema = getJsonSchemaFromSchema(value.inputSchema) as JSONSchema;
      } else if (UntrackedValue.isInstance(value)) {
        fieldSchema = value.schema
          ? (getJsonSchemaFromSchema(value.schema) as JSONSchema)
          : undefined;
      } else if (isStandardSchema(value)) {
        fieldSchema = getJsonSchemaFromSchema(value) as JSONSchema;
      }

      if (fieldSchema) {
        properties[key] = fieldSchema;
      }
    }

    return {
      type: "object",
      properties,
    };
  }

  /**
   * Get the list of channel keys (excluding managed values).
   */
  getChannelKeys(): string[] {
    return Object.entries(this.fields).map(([key]) => key);
  }

  /**
   * Get all keys (channels + managed values).
   */
  getAllKeys(): string[] {
    return Object.keys(this.fields);
  }

  /**
   * Validate input data against the schema.
   * This validates each field using its corresponding schema.
   *
   * @param data - The input data to validate
   * @returns The validated data with coerced types
   */
  async validateInput<T>(data: T): Promise<T> {
    if (data == null || typeof data !== "object") {
      return data;
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      const fieldDef = this.fields[key];

      if (fieldDef === undefined) {
        // Unknown field, pass through
        result[key] = value;
        continue;
      }

      // Get the schema to use for validation
      let schema: StandardSchemaV1 | undefined;

      if (ReducedValue.isInstance(fieldDef)) {
        schema = fieldDef.inputSchema;
      } else if (UntrackedValue.isInstance(fieldDef)) {
        schema = fieldDef.schema;
      } else if (isStandardSchema(fieldDef)) {
        schema = fieldDef;
      }

      if (schema) {
        // Validate using standard schema
        const validationResult = await schema["~standard"].validate(value);
        if (validationResult.issues) {
          throw new Error(
            `Validation failed for field "${key}": ${JSON.stringify(
              validationResult.issues
            )}`
          );
        }
        result[key] = validationResult.value;
      } else {
        // No schema or not a standard schema, pass through
        result[key] = value;
      }
    }

    return result as T;
  }

  /**
   * Type guard to check if a value is a StateSchema instance.
   *
   * @param value - The value to check.
   * @returns True if the value is a StateSchema instance with the correct runtime tag.
   */
  static isInstance<TFields extends StateSchemaFields>(
    value: StateSchema<TFields>
  ): value is StateSchema<TFields>;

  static isInstance(value: unknown): value is StateSchema<any>;

  static isInstance<TFields extends StateSchemaFields>(
    value: unknown
  ): value is StateSchema<TFields> {
    return (
      typeof value === "object" &&
      value !== null &&
      STATE_SCHEMA_SYMBOL in value &&
      value[STATE_SCHEMA_SYMBOL] === true
    );
  }
}

export type AnyStateSchema = StateSchema<any>;
