import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./index.js";

const areSetsEqual = (a: Set<unknown>, b: Set<unknown>) =>
  a.size === b.size && [...a].every((value) => b.has(value));
/**
 * A channel that waits until all named values are received before making the value available.
 *
 * This ensures that if node N and node M both write to channel C, the value of C will not be updated
 * until N and M have completed updating.
 */
export class NamedBarrierValue<Value> extends BaseChannel<
  Value,
  Value,
  Set<Value>
> {
  lc_graph_name = "NamedBarrierValue";

  names: Set<Value>; // Names of nodes that we want to wait for.

  seen: Set<Value>;

  constructor(names: Set<Value>) {
    super();
    this.names = names;
    this.seen = new Set<Value>();
  }

  fromCheckpoint(checkpoint?: Set<Value>) {
    const empty = new NamedBarrierValue<Value>(this.names);
    if (checkpoint) {
      empty.seen = checkpoint;
    }
    return empty as this;
  }

  update(values: Value[]): void {
    // We have seen all nodes, so we can reset the seen set in preparation for the next round of updates.
    if (areSetsEqual(this.names, this.seen)) {
      this.seen = new Set<Value>();
    }
    for (const nodeName of values) {
      if (this.names.has(nodeName)) {
        this.seen.add(nodeName);
      } else {
        throw new Error(
          `Value ${JSON.stringify(nodeName)} not in names ${JSON.stringify(
            this.names
          )}`
        );
      }
    }
  }

  // If we have not yet seen all the node names we want to wait for, throw an error to
  // prevent continuing.
  get(): Value {
    if (!areSetsEqual(this.names, this.seen)) {
      throw new EmptyChannelError();
    }
    return undefined as Value;
  }

  checkpoint(): Set<Value> {
    return this.seen;
  }
}
