import { BaseChannel } from "./base.js";

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

  public fromCheckpoint(checkpoint?: [Set<Value>, Value[]]) {
    const empty = new Topic<Value>({
      unique: this.unique,
      accumulate: this.accumulate,
    });
    if (checkpoint) {
      [empty.seen, empty.values] = checkpoint;
    }
    return empty as this;
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
