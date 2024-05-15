import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./index.js";

/**
 * Stores the last value received, can receive at most one value per step.
 *
 * Since `update` is only called once per step and value can only be of length 1,
 * LastValue always stores the last value of a single node. If multiple nodes attempt to
 * write to this channel in a single step, an error will be thrown.
 */
export class LastValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "LastValue";

  value?: Value;

  fromCheckpoint(checkpoint?: Value) {
    const empty = new LastValue<Value>();
    if (checkpoint) {
      empty.value = checkpoint;
    }

    return empty as this;
  }

  update(values: Value[]): void {
    if (values.length === 0) {
      return;
    }
    if (values.length !== 1) {
      throw new InvalidUpdateError();
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
