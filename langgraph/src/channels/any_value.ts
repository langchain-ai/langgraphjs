import { BaseChannel, EmptyChannelError } from "./index.js";

/**
 * Stores the last value received, assumes that if multiple values are received, they are all equal.
 *
 * Note: Unlike 'LastValue' if multiple nodes write to this channel in a single step, the values
 * will be continuously overwritten.
 */
export class AnyValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "AnyValue";

  value: Value | undefined;

  constructor() {
    super();
    this.value = undefined;
  }

  fromCheckpoint(checkpoint?: Value): AnyValue<Value> {
    const empty = new AnyValue<Value>();
    if (checkpoint) {
      empty.value = checkpoint;
    }
    return empty;
  }

  update(values: Value[]): void {
    if (values.length === 0) {
      this.value = undefined;
      return;
    }

    // eslint-disable-next-line prefer-destructuring
    this.value = values[values.length - 1];
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
