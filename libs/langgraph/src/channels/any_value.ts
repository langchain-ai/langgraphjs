import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * Stores the last value received, assumes that if multiple values are received, they are all equal.
 *
 * Note: Unlike 'LastValue' if multiple nodes write to this channel in a single step, the values
 * will be continuously overwritten.
 *
 * @internal
 */
export class AnyValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "AnyValue";

  // value is an array so we don't misinterpret an update to undefined as no write
  value: [Value] | [] = [];

  constructor() {
    super();
  }

  fromCheckpoint(checkpoint?: Value) {
    const empty = new AnyValue<Value>();
    if (typeof checkpoint !== "undefined") {
      empty.value = [checkpoint];
    }
    return empty as this;
  }

  update(values: Value[]): boolean {
    if (values.length === 0) {
      const updated = this.value.length > 0;
      this.value = [];
      return updated;
    }

    // eslint-disable-next-line prefer-destructuring
    this.value = [values[values.length - 1]];
    return false;
  }

  get(): Value {
    if (this.value.length === 0) {
      throw new EmptyChannelError();
    }
    return this.value[0];
  }

  checkpoint(): Value {
    if (this.value.length === 0) {
      throw new EmptyChannelError();
    }
    return this.value[0];
  }

  isAvailable(): boolean {
    return this.value.length !== 0;
  }
}
