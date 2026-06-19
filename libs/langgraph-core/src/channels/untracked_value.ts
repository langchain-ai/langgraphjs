import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

// Sentinel value for missing/unset
const MISSING = Symbol.for("langgraph.channel.missing");

/**
 * Stores the last value received, never checkpointed.
 *
 * This channel stores values during graph execution but does NOT persist
 * the value to checkpoints. On restoration from a checkpoint, the value
 * will be reset to empty (or the initial value if provided).
 *
 * Useful for transient state like:
 * - Database connections
 * - Temporary caches
 * - Runtime-only configuration
 *
 * @internal
 */
export class UntrackedValueChannel<Value> extends BaseChannel<
  Value,
  Value,
  undefined
> {
  lc_graph_name = "UntrackedValue";

  /**
   * If true, throws an error when multiple values are received in a single step.
   * If false, stores the last value received.
   */
  guard: boolean;

  /**
   * The current value. MISSING sentinel indicates no value has been set.
   */
  private _value: Value | typeof MISSING = MISSING;

  /**
   * Optional factory function for the initial value.
   */
  private initialValueFactory?: () => Value;

  constructor(options?: {
    guard?: boolean;
    initialValueFactory?: () => Value;
  }) {
    super();
    this.guard = options?.guard ?? true;
    this.initialValueFactory = options?.initialValueFactory;
    if (this.initialValueFactory) {
      this._value = this.initialValueFactory();
    }
  }

  /**
   * Return a new channel, ignoring the checkpoint since we don't persist.
   * The initial value (if any) is restored.
   */
  fromCheckpoint(_checkpoint?: undefined): this {
    const empty = new UntrackedValueChannel<Value>({
      guard: this.guard,
      initialValueFactory: this.initialValueFactory,
    });
    return empty as this;
  }

  /**
   * Update the channel with the given values.
   * If guard is true, throws if more than one value is received.
   */
  update(values: Value[]): boolean {
    if (values.length === 0) {
      return false;
    }

    if (values.length !== 1 && this.guard) {
      throw new InvalidUpdateError(
        "UntrackedValue(guard=true) can receive only one value per step. " +
          "Use guard=false if you want to store any one of multiple values.",
        { lc_error_code: "INVALID_CONCURRENT_GRAPH_UPDATE" }
      );
    }

    this._value = values[values.length - 1];
    return true;
  }

  /**
   * Get the current value.
   * @throws EmptyChannelError if no value has been set.
   */
  get(): Value {
    if (this._value === MISSING) {
      throw new EmptyChannelError();
    }
    return this._value;
  }

  /**
   * Always returns undefined - untracked values are never checkpointed.
   */
  checkpoint(): undefined {
    return undefined;
  }

  /**
   * Return true if a value has been set.
   */
  isAvailable(): boolean {
    return this._value !== MISSING;
  }
}
