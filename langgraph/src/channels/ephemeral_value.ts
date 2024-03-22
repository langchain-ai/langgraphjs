import { BaseChannel, EmptyChannelError, InvalidUpdateError } from "./index.js";

/**
 * Stores the value received in the step immediately preceding, clears after.
 */
export class EphemeralValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "EphemeralValue";

  guard: boolean;

  value?: Value;


  constructor(guard: boolean = true) {
    super();
    this.guard = guard;
  }

  empty(checkpoint?: Value): EphemeralValue<Value> {
    const empty = new EphemeralValue<Value>();
    if (checkpoint) {
      empty.value = checkpoint;
    }
    const valueToReturn = { ...empty };
    // Clear the value because it's ephemeral.
    empty.value = undefined;
    return valueToReturn;
  }

  update(values: Value[]): void {
    if (values.length === 0) {
      this.value = undefined;
      return;
    }
    if (values.length !== 1 && this.guard) {
      throw new InvalidUpdateError('EphemeralValue can only receive one value per step.')
    }

    // eslint-disable-next-line prefer-destructuring
    this.value = values[0];
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
