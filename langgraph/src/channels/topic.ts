import { BaseChannel, EmptyChannelError } from "./base.js";

function* flatten<Value>(
  values: Array<Value | Value[]>
): IterableIterator<Value> {
  for (const value of values) {
    if (Array.isArray(value)) {
      yield* value;
    } else {
      yield value;
    }
  }
}

export class Topic<Value> extends BaseChannel<
  Array<Value>,
  Value | Value[],
  [Set<Value>, Value[]]
> {
  lc_graph_name = "Topic";

  typ?: Value;

  unique = false;

  accumulate = false;

  seen: Set<Value>;

  values: Value[];

  constructor(fields?: { unique?: boolean; accumulate?: boolean }) {
    super();

    this.unique = fields?.unique ?? this.unique;
    this.accumulate = fields?.accumulate ?? this.accumulate;
    // State
    this.seen = new Set<Value>();
    this.values = [];
  }

  /**
   * The type of the value stored in the channel.
   *
   * @returns {Array<Value> | undefined}
   */
  public get ValueType(): [Value] | undefined {
    throw new Error("Not implemented");
  }

  /**
   * The type of the update received by the channel.
   *
   * @returns {Value | undefined}
   */
  public get UpdateType(): Value | undefined {
    throw new Error("Not implemented");
  }

  public *empty(checkpoint?: [Set<Value>, Value[]]): Generator<Topic<Value>> {
    const empty = new Topic<Value>({
      unique: this.unique,
      accumulate: this.accumulate,
    });
    if (checkpoint) {
      [empty.seen, empty.values] = checkpoint;
    }
    yield empty;
  }

  public update(values: Array<Value | Value[]>): void {
    if (!this.accumulate) {
      this.values = [];
    }
    const flatValues = flatten<Value>(values);
    if (flatValues) {
      if (this.unique) {
        for (const value of flatValues) {
          if (!this.seen.has(value)) {
            this.seen.add(value);
            this.values.push(value);
          }
        }
      } else {
        this.values.push(...flatValues);
      }
    }
  }

  public get(): Array<Value> {
    return this.values;
  }

  public checkpoint(): [Set<Value>, Array<Value>] {
    if (!this.values || this.values.length === 0) {
      throw new EmptyChannelError();
    }
    return [this.seen, this.values];
  }
}
