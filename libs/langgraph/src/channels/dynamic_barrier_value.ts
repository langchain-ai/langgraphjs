import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";
import { areSetsEqual } from "./named_barrier_value.js";

export interface WaitForNames<Value> {
  __names: Value[];
}

function isWaitForNames<Value>(
  v: WaitForNames<Value> | Value
): v is WaitForNames<Value> {
  return (v as WaitForNames<Value>).__names !== undefined;
}

/**
 * A channel that switches between two states
 *
 * - in the "priming" state it can't be read from.
 *     - if it receives a WaitForNames update, it switches to the "waiting" state.
 * - in the "waiting" state it collects named values until all are received.
 *     - once all named values are received, it can be read once, and it switches
 *       back to the "priming" state.
 * @internal
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
    if (typeof checkpoint !== "undefined") {
      empty.names = new Set(checkpoint[0]);
      empty.seen = new Set(checkpoint[1]);
    }
    return empty as this;
  }

  update(values: (Value | WaitForNames<Value>)[]): boolean {
    const waitForNames = values.filter(isWaitForNames);
    if (waitForNames.length > 0) {
      if (waitForNames.length > 1) {
        throw new InvalidUpdateError(
          "Received multiple WaitForNames updates in the same step."
        );
      }
      this.names = new Set(waitForNames[0].__names);
      return true;
    } else if (this.names !== undefined) {
      let updated = false;
      for (const value of values) {
        if (isWaitForNames(value)) {
          throw new Error(
            "Assertion Error: Received unexpected WaitForNames instance."
          );
        }
        if (this.names.has(value) && !this.seen.has(value)) {
          this.seen.add(value);
          updated = true;
        }
      }
      return updated;
    }
    return false;
  }

  consume(): boolean {
    if (this.seen && this.names && areSetsEqual(this.seen, this.names)) {
      this.seen = new Set<Value>();
      this.names = undefined;
      return true;
    }
    return false;
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

  isAvailable(): boolean {
    return !!this.names && areSetsEqual(this.names, this.seen);
  }
}

/**
 * A channel that switches between two states with an additional finished flag
 *
 * - in the "priming" state it can't be read from.
 *     - if it receives a WaitForNames update, it switches to the "waiting" state.
 * - in the "waiting" state it collects named values until all are received.
 *     - once all named values are received, and the finished flag is set, it can be read once, and it switches
 *       back to the "priming" state.
 * @internal
 */
export class DynamicBarrierValueAfterFinish<Value> extends BaseChannel<
  void,
  Value | WaitForNames<Value>,
  [Value[] | undefined, Value[], boolean]
> {
  lc_graph_name = "DynamicBarrierValueAfterFinish";

  names?: Set<Value>; // Names of nodes that we want to wait for.

  seen: Set<Value>;

  finished: boolean;

  constructor() {
    super();
    this.names = undefined;
    this.seen = new Set<Value>();
    this.finished = false;
  }

  fromCheckpoint(checkpoint?: [Value[] | undefined, Value[], boolean]) {
    const empty = new DynamicBarrierValueAfterFinish<Value>();
    if (typeof checkpoint !== "undefined") {
      const [names, seen, finished] = checkpoint;
      empty.names = names ? new Set(names) : undefined;
      empty.seen = new Set(seen);
      empty.finished = finished;
    }
    return empty as this;
  }

  update(values: (Value | WaitForNames<Value>)[]): boolean {
    const waitForNames = values.filter(isWaitForNames);
    if (waitForNames.length > 0) {
      if (waitForNames.length > 1) {
        throw new InvalidUpdateError(
          "Received multiple WaitForNames updates in the same step."
        );
      }
      this.names = new Set(waitForNames[0].__names);
      return true;
    } else if (this.names !== undefined) {
      let updated = false;
      for (const value of values) {
        if (isWaitForNames(value)) {
          throw new Error(
            "Assertion Error: Received unexpected WaitForNames instance."
          );
        }
        if (this.names.has(value) && !this.seen.has(value)) {
          this.seen.add(value);
          updated = true;
        }
      }
      return updated;
    }
    return false;
  }

  consume(): boolean {
    if (
      this.finished &&
      this.seen &&
      this.names &&
      areSetsEqual(this.seen, this.names)
    ) {
      this.seen = new Set<Value>();
      this.names = undefined;
      this.finished = false;
      return true;
    }
    return false;
  }

  finish(): boolean {
    if (!this.finished && this.names && areSetsEqual(this.names, this.seen)) {
      this.finished = true;
      return true;
    }
    return false;
  }

  get(): void {
    if (!this.finished || !this.names || !areSetsEqual(this.names, this.seen)) {
      throw new EmptyChannelError();
    }
    return undefined;
  }

  checkpoint(): [Value[] | undefined, Value[], boolean] {
    return [
      this.names ? [...this.names] : undefined,
      [...this.seen],
      this.finished,
    ];
  }

  isAvailable(): boolean {
    return this.finished && !!this.names && areSetsEqual(this.names, this.seen);
  }
}
