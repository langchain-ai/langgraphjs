import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * Stores the value received in the step immediately preceding, clears after.
 * @internal
 */
export class EphemeralValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "EphemeralValue";

  guard: boolean;

  // value is an array so we don't misinterpret an update to undefined as no write
  value: [Value] | [] = [];

  constructor(guard: boolean = true) {
    super();
    this.guard = guard;
  }

  fromCheckpoint(checkpoint?: Value) {
    const empty = new EphemeralValue<Value>(this.guard);
    if (typeof checkpoint !== "undefined") {
      empty.value = [checkpoint];
    }
    return empty as this;
  }

  update(values: Value[]): boolean {
    if (values.length === 0) {
      const updated = this.value.length > 0;
      // If there are no updates for this specific channel at the end of the step, wipe it.
      this.value = [];
      return updated;
    }
    if (values.length !== 1 && this.guard) {
      throw new InvalidUpdateError(
        "EphemeralValue can only receive one value per step."
      );
    }

    // eslint-disable-next-line prefer-destructuring
    this.value = [values[values.length - 1]];
    return true;
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
