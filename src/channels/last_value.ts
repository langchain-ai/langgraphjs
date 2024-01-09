import { BaseChannel, EmptyChannelError, InvalidUpdateError } from "./index.js";

/**
 * Stores the last value received, can receive at most one value per step.
 */
export class LastValue<Value> extends BaseChannel<Value, Value, Value> {
  typ: new () => Value;

  value?: Value;

  constructor(typ: new () => Value) {
    super();
    this.typ = typ;
  }

  /**
   * The type of the value stored in the channel.
   *
   * @returns {new () => Value}
   */
  public get ValueType(): new () => Value {
    return this.typ;
  }

  /**
   * The type of the update received by the channel.
   *
   * @returns {new () => Value}
   */
  public get UpdateType(): new () => Value {
    return this.typ;
  }

  async *empty(checkpoint?: Value): AsyncGenerator<LastValue<Value>> {
    const empty = new LastValue<Value>(this.typ);
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

  async update(values: Value[]): Promise<void> {
    if (values.length === 0) {
      return;
    }
    if (values.length !== 1) {
      throw new InvalidUpdateError();
    }

    [this.value] = values;
  }

  async get(): Promise<Value> {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  async checkpoint(): Promise<Value> {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }
}
