import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./index.js";

/**
 * Stores the value received in the step immediately preceding, clears after.
 * @internal
 */
export class EphemeralValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "EphemeralValue";

  guard: boolean;

  value?: Value;

  constructor(guard: boolean = true) {
    super();
    this.guard = guard;
  }

  fromCheckpoint(checkpoint?: Value) {
    const empty = new EphemeralValue<Value>(this.guard);
    if (checkpoint) {
      empty.value = checkpoint;
    }
    return empty as this;
  }

  update(values: Value[]): boolean {
    if (values.length === 0) {
      const updated = this.value !== undefined;
      // If there are no updates for this specific channel at the end of the step, wipe it.
      this.value = undefined;
      return updated;
    }
    if (values.length !== 1 && this.guard) {
      throw new InvalidUpdateError(
        "EphemeralValue can only receive one value per step."
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
