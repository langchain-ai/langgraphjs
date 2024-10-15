import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * Stores the last value received, can receive at most one value per step.
 *
 * Since `update` is only called once per step and value can only be of length 1,
 * LastValue always stores the last value of a single node. If multiple nodes attempt to
 * write to this channel in a single step, an error will be thrown.
 * @internal
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

  update(values: Value[]): boolean {
    if (values.length === 0) {
      return false;
    }
    if (values.length !== 1) {
      throw new InvalidUpdateError(
        "LastValue can only receive one value per step.",
        {
          code: "INVALID_CONCURRENT_GRAPH_UPDATE",
        }
      );
    }

    // eslint-disable-next-line prefer-destructuring
    this.value = values[values.length - 1];
    return true;
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
