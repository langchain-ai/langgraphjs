import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

export const areSetsEqual = <T>(a: Set<T>, b: Set<T>) =>
  a.size === b.size && [...a].every((value) => b.has(value));

/**
 * A channel that waits until all named values are received before making the value available.
 *
 * This ensures that if node N and node M both write to channel C, the value of C will not be updated
 * until N and M have completed updating.
 * @internal
 */
export class NamedBarrierValue<Value> extends BaseChannel<
  void,
  Value,
  Value[]
> {
  lc_graph_name = "NamedBarrierValue";

  names: Set<Value>; // Names of nodes that we want to wait for.

  seen: Set<Value>;

  constructor(names: Set<Value>) {
    super();
    this.names = names;
    this.seen = new Set<Value>();
  }

  fromCheckpoint(checkpoint?: Value[]) {
    const empty = new NamedBarrierValue<Value>(this.names);
    if (checkpoint) {
      empty.seen = new Set(checkpoint);
    }
    return empty as this;
  }

  update(values: Value[]): boolean {
    let updated = false;
    for (const nodeName of values) {
      if (this.names.has(nodeName)) {
        if (!this.seen.has(nodeName)) {
          this.seen.add(nodeName);
          updated = true;
        }
      } else {
        throw new InvalidUpdateError(
          `Value ${JSON.stringify(nodeName)} not in names ${JSON.stringify(
            this.names
          )}`
        );
      }
    }
    return updated;
  }

  // If we have not yet seen all the node names we want to wait for,
  // throw an error to prevent continuing.
  get(): void {
    if (!areSetsEqual(this.names, this.seen)) {
      throw new EmptyChannelError();
    }
    return undefined;
  }

  checkpoint(): Value[] {
    return [...this.seen];
  }

  consume(): boolean {
    if (this.seen && this.names && areSetsEqual(this.seen, this.names)) {
      this.seen = new Set<Value>();
      return true;
    }
    return false;
  }
}
