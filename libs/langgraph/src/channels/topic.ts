import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * A configurable PubSub Topic.
 */
export class Topic<Value> extends BaseChannel<
  Array<Value>,
  Value | Value[],
  [Value[], Value[]]
> {
  lc_graph_name = "Topic";

  unique = false;

  accumulate = false;

  seen: Set<Value>;

  values: Value[];

  constructor(fields?: {
    /**
     * Whether to only add unique values to the topic. If `true`, only unique values (using reference equality) will be added to the topic.
     */
    unique?: boolean;
    /**
     * Whether to accumulate values across steps. If `false`, the channel will be emptied after each step.
     */
    accumulate?: boolean;
  }) {
    super();

    this.unique = fields?.unique ?? this.unique;
    this.accumulate = fields?.accumulate ?? this.accumulate;
    // State
    this.seen = new Set<Value>();
    this.values = [];
  }

  public fromCheckpoint(checkpoint?: [Value[], Value[]]) {
    const empty = new Topic<Value>({
      unique: this.unique,
      accumulate: this.accumulate,
    });
    if (typeof checkpoint !== "undefined") {
      empty.seen = new Set(checkpoint[0]);
      // eslint-disable-next-line prefer-destructuring
      empty.values = checkpoint[1];
    }
    return empty as this;
  }

  public update(values: Array<Value | Value[]>): boolean {
    let updated = false;
    if (!this.accumulate) {
      updated = this.values.length > 0;
      this.values = [];
    }
    const flatValues = values.flat() as Value[];
    if (flatValues.length > 0) {
      if (this.unique) {
        for (const value of flatValues) {
          if (!this.seen.has(value)) {
            updated = true;
            this.seen.add(value);
            this.values.push(value);
          }
        }
      } else {
        updated = true;
        this.values.push(...flatValues);
      }
    }
    return updated;
  }

  public get(): Array<Value> {
    if (this.values.length === 0) {
      throw new EmptyChannelError();
    }
    return this.values;
  }

  public checkpoint(): [Value[], Value[]] {
    return [[...this.seen], this.values];
  }

  isAvailable(): boolean {
    return this.values.length !== 0;
  }
}
