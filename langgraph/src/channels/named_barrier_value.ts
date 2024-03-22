import { BaseChannel, EmptyChannelError } from "./index.js";

// Question: should it node N and M or channel N and M? Because technically, nodes don't inherently have values.

const areSetsEqual = (a: Set<unknown>, b: Set<unknown>) =>
  a.size === b.size && [...a].every((value) => b.has(value));
/**
 * A channel that waits until all named values are received before making the value available.
 *
 * This ensures that if node N and node M both write to channel C, the value of C will not be updated
 * until N and M have completed updating.
 */
export class NamedBarrierValue<Value> extends BaseChannel<Value, Value, Value> {
  lc_graph_name = "NamedBarrierValue";

  names: Set<Value>;

  seen: Set<Value>;

  constructor(names: Set<Value>) {
    super();
    this.names = names;
    this.seen = new Set<Value>();
  }

  empty(checkpoint?: Value): NamedBarrierValue<Value> {
    const empty = new NamedBarrierValue<Value>(this.names);
    if (checkpoint) {
      empty.seen = checkpoint;
    }
    return empty;
  }

  update(values: Value[]): void {
    if (areSetsEqual(this.names, this.seen)) {
      this.seen = new Set<Value>();
    }
    for (const value in values) {
      if (value in this.names) {
        this.seen.add(value);
      } else {
        throw new Error(`Value ${value} not in names ${this.names}`);
      }
    }
  }

  get(): Value {
    if (!areSetsEqual(this.names, this.seen)) {
      throw new EmptyChannelError();
    }
    return undefined;
  }

  checkpoint(): Value {
    return this.seen;
  }
}
