import { BaseChannel, EmptyChannelError, InvalidUpdateError } from "./index.js";

/**
 * Stores the last value received, can receive at most one value per step.
 */
export class LastValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "LastValue";

  value?: Value;

  empty(checkpoint?: Value): LastValue<Value> {
    const empty = new LastValue<Value>();
    if (checkpoint) {
      empty.value = checkpoint;
    }

    return empty;
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
