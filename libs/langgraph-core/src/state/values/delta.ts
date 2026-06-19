import type { SerializableSchema } from "../types.js";
import type { DeltaReducer } from "../../channels/delta.js";

/**
 * Symbol for runtime identification of DeltaValue instances.
 */
export const DELTA_VALUE_SYMBOL: symbol = Symbol.for(
  "langgraph.state.delta_value"
);

interface DeltaValueInitBase<Value = unknown> {
  /**
   * Batch reducer that combines the current accumulated value with a batch of
   * writes in a single call: `reducer(state, [w1, w2, ...]) -> newState`.
   *
   * Reducers must be deterministic and batching-invariant (associative across
   * folds), because {@link DeltaChannel} replays checkpointed writes in larger
   * batches than they were originally produced:
   * `reducer(reducer(state, xs), ys) === reducer(state, xs.concat(ys))`.
   */
  reducer: DeltaReducer<Value, Value>;

  /**
   * How often (in per-channel updates) to persist a full `DeltaSnapshot` blob
   * instead of relying purely on replayed deltas. Defaults to the channel's
   * own default (1000) when omitted.
   */
  snapshotFrequency?: number;

  /**
   * Optional extra fields merged into the generated JSON Schema (e.g.
   * `langgraph_type`) for documentation, Studio hints, or external tooling.
   */
  jsonSchemaExtra?: Record<string, unknown>;
}

interface DeltaValueInitWithSchema<Value = unknown, Input = Value> {
  /**
   * Schema describing the type and validation logic for reducer input values.
   *
   * When provided, the reducer may accept inputs distinct from the stored
   * (output) type. Each write is validated against this schema before reduction.
   */
  inputSchema: SerializableSchema<unknown, Input>;

  /**
   * Batch reducer that combines the current accumulated value with a batch of
   * validated writes: `reducer(state, [w1, w2, ...]) -> newState`.
   *
   * Must be deterministic and batching-invariant — see
   * {@link DeltaValueInitBase.reducer}.
   */
  reducer: DeltaReducer<Value, Input>;

  /**
   * How often (in per-channel updates) to persist a full `DeltaSnapshot` blob.
   * Defaults to the channel's own default (1000) when omitted.
   */
  snapshotFrequency?: number;

  /**
   * Optional extra fields merged into the generated JSON Schema (e.g.
   * `langgraph_type`) for documentation, Studio hints, or external tooling.
   */
  jsonSchemaExtra?: Record<string, unknown>;
}

/**
 * Initialization options for {@link DeltaValue}.
 *
 * Two forms are supported:
 * 1. Provide only a reducer (and optionally `snapshotFrequency` /
 *    `jsonSchemaExtra`) — the reducer's inputs are validated using the value
 *    schema.
 * 2. Provide an explicit `inputSchema` to distinguish the reducer's input type
 *    from the stored/output type.
 *
 * @template Value - The type of value stored and produced after reduction.
 * @template Input - The type of inputs accepted by the reducer.
 */
export type DeltaValueInit<Value = unknown, Input = Value> =
  | DeltaValueInitWithSchema<Value, Input>
  | DeltaValueInitBase<Value>;

/**
 * Represents a state field backed by a {@link DeltaChannel}.
 *
 * Unlike {@link ReducedValue} (which stores the full accumulated value in every
 * checkpoint blob via `BinaryOperatorAggregate`), a `DeltaValue` field persists
 * only per-step deltas (plus periodic snapshots) and reconstructs its state on
 * read by replaying ancestor writes through a batch reducer. This avoids
 * re-serializing large accumulators (e.g. long message histories) at every step.
 *
 * @remarks Beta. The on-disk representation backing `DeltaChannel` may change in
 * future releases.
 *
 * @template Value - The type of the value stored in state and produced by reduction.
 * @template Input - The type of updates accepted by the reducer.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { StateSchema, DeltaValue } from "@langchain/langgraph";
 *
 * const State = new StateSchema({
 *   history: new DeltaValue(z.array(z.string()).default(() => []), {
 *     inputSchema: z.string(),
 *     reducer: (current, writes) => [...current, ...writes],
 *   }),
 * });
 * ```
 */
export class DeltaValue<Value = unknown, Input = Value> {
  /**
   * Instance marker for runtime identification.
   * @internal
   */
  protected readonly [DELTA_VALUE_SYMBOL] = true as const;

  /**
   * The schema that describes the type of value stored in state (after
   * reduction). Its default (if any) seeds the channel's initial value.
   */
  readonly valueSchema: SerializableSchema<unknown, Value>;

  /**
   * The schema used to validate reducer inputs. Defaults to `valueSchema` when
   * not specified explicitly.
   */
  readonly inputSchema: SerializableSchema<unknown, Input | Value>;

  /**
   * The batch reducer that folds a list of incoming writes into the current
   * accumulated value.
   */
  readonly reducer: DeltaReducer<Value, Input>;

  /**
   * Snapshot cadence forwarded to the underlying {@link DeltaChannel}.
   */
  readonly snapshotFrequency?: number;

  /**
   * Optional extra fields to merge into the generated JSON Schema.
   */
  readonly jsonSchemaExtra?: Record<string, unknown>;

  /**
   * Represents the value stored after all reductions.
   */
  declare ValueType: Value;

  /**
   * Represents the type that may be provided as input on each update.
   */
  declare InputType: Input;

  /**
   * Constructs a DeltaValue, pairing a value schema with a batch reducer (and an
   * optional distinct input schema).
   *
   * @param valueSchema - The schema describing the stored/output value.
   * @param init - The reducer (required), `inputSchema`, `snapshotFrequency`,
   *   and `jsonSchemaExtra` (all optional except the reducer).
   */
  constructor(
    valueSchema: SerializableSchema<unknown, Value>,
    init: DeltaValueInitWithSchema<Value, Input>
  );

  constructor(
    valueSchema: SerializableSchema<Input, Value>,
    init: DeltaValueInitBase<Value>
  );

  constructor(
    valueSchema: SerializableSchema<unknown, Value>,
    init: DeltaValueInit<Value, Input>
  ) {
    this.reducer = init.reducer as DeltaReducer<Value, Input>;
    this.valueSchema = valueSchema;
    this.inputSchema = "inputSchema" in init ? init.inputSchema : valueSchema;
    this.snapshotFrequency = init.snapshotFrequency;
    this.jsonSchemaExtra = init.jsonSchemaExtra;
  }

  /**
   * Type guard to check if a value is a DeltaValue instance.
   */
  static isInstance<Value = unknown, Input = Value>(
    value: DeltaValue<Value, Input>
  ): value is DeltaValue<Value, Input>;

  static isInstance(value: unknown): value is DeltaValue;

  static isInstance<Value = unknown, Input = Value>(
    value: DeltaValue<Value, Input> | unknown
  ): value is DeltaValue<Value, Input> {
    return (
      typeof value === "object" &&
      value !== null &&
      DELTA_VALUE_SYMBOL in value &&
      (value as Record<symbol, unknown>)[DELTA_VALUE_SYMBOL] === true
    );
  }
}
