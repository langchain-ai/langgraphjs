import { BaseChannel } from "./base.js";

function* flatten<Value>(values: Array<Value | Value[]>): IterableIterator<Value> {
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
  typ: new () => Value;

  unique: boolean;

  accumulate: boolean;

  seen: Set<Value>;

  values: Value[];

  constructor(
    typ: new () => Value,
    unique: boolean = false,
    accumulate: boolean = false
  ) {
    super();

    this.typ = typ;
    this.unique = unique;
    this.accumulate = accumulate;
    // State
    this.seen = new Set<Value>();
    this.values = [];
  }

  /**
   * The type of the value stored in the channel.
   *
   * @returns {Array<new () => Value>}
   */
  public get ValueType(): [new () => Value] {
    return [this.typ];
  }

  /**
   * The type of the update received by the channel.
   *
   * @returns {new () => Value}
   */
  public get UpdateType(): new () => Value {
    return this.typ;
  }

  public *empty(
    checkpoint?: [Set<Value>, Value[]]
  ): Generator<Topic<Value>> {
    const empty = new Topic(this.typ, this.unique, this.accumulate);
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
    return [this.seen, this.values];
  }
}
