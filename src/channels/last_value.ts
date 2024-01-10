import { BaseChannel, EmptyChannelError, InvalidUpdateError } from "./index.js";

/**
 * Stores the last value received, can receive at most one value per step.
 */
export class LastValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "LastValue";

  typ?: Value;

  value?: Value;

  constructor() {
    super();
  }

  /**
   * The type of the value stored in the channel.
   *
   * @returns {new () => Value}
   */
  public get ValueType(): Value | undefined {
    return this.typ;
  }

  /**
   * The type of the update received by the channel.
   *
   * @returns {new () => Value}
   */
  public get UpdateType(): Value | undefined {
    return this.typ;
  }

  *empty(checkpoint?: Value): Generator<LastValue<Value>> {
    const empty = new LastValue<Value>();
    if (checkpoint) {
      empty.value = checkpoint;
    }

    try {
      yield empty;
    } finally {
      try {
        empty.value = undefined;
      } catch (e) {
        // no-op
      }
    }
  }

  update(values: Value[]): void {
    if (values.length === 0) {
      return;
    }
    if (values.length !== 1) {
      throw new InvalidUpdateError();
    }

    [this.value] = values;
  }

  get(): Value {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  checkpoint(): Value {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }
}
