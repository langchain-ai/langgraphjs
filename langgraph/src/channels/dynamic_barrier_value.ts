import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./index.js";
import { areSetsEqual } from "./named_barrier_value.js";

export interface WaitForNames<Value> {
  __names: Value[];
}

/**
  A channel that switches between two states

    - in the "priming" state it can't be read from.
        - if it receives a WaitForNames update, it switches to the "waiting" state.
    - in the "waiting" state it collects named values until all are received.
        - once all named values are received, it can be read once, and it switches
          back to the "priming" state.
 */
export class DynamicBarrierValue<Value> extends BaseChannel<
  void,
  Value | WaitForNames<Value>,
  [Value[] | undefined, Value[]]
> {
  lc_graph_name = "DynamicBarrierValue";

  names?: Set<Value>; // Names of nodes that we want to wait for.

  seen: Set<Value>;

  constructor() {
    super();
    this.names = undefined;
    this.seen = new Set<Value>();
  }

  fromCheckpoint(checkpoint?: [Value[] | undefined, Value[]]) {
    const empty = new DynamicBarrierValue<Value>();
    if (checkpoint) {
      empty.names = new Set(checkpoint[0]);
      empty.seen = new Set(checkpoint[1]);
    }
    return empty as this;
  }

  update(values: (Value | WaitForNames<Value>)[]): void {
    // switch to priming state after reading it once
    if (this.names && areSetsEqual(this.names, this.seen)) {
      this.seen = new Set<Value>();
      this.names = undefined;
    }

    const newNames = values.filter(
      (v) =>
        typeof v === "object" &&
        !!v &&
        "__names" in v &&
        Object.keys(v).join(",") === "__names" &&
        Array.isArray(v.__names)
    ) as WaitForNames<Value>[];

    if (newNames.length > 1) {
      throw new InvalidUpdateError(
        `Expected at most one WaitForNames object, got ${newNames.length}`
      );
    } else if (newNames.length === 1) {
      this.names = new Set(newNames[0].__names);
    } else if (this.names) {
      for (const value of values) {
        if (this.names.has(value as Value)) {
          this.seen.add(value as Value);
        } else {
          throw new InvalidUpdateError(
            `Value ${value} not in names ${this.names}`
          );
        }
      }
    }
  }

  // If we have not yet seen all the node names we want to wait for,
  // throw an error to prevent continuing.
  get(): void {
    if (!this.names || !areSetsEqual(this.names, this.seen)) {
      throw new EmptyChannelError();
    }
    return undefined;
  }

  checkpoint(): [Value[] | undefined, Value[]] {
    return [this.names ? [...this.names] : undefined, [...this.seen]];
  }
}
