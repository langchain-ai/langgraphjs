import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * Legacy JS Topic checkpoint shape: `[seen, values]`.
 *
 * Current checkpoints match Python and store a flat `values` list. Keep reading
 * the tuple form so threads checkpointed before that change still restore.
 */
function isLegacyTopicCheckpoint<Value>(
  checkpoint: unknown
): checkpoint is [Value[], Value[]] {
  return (
    Array.isArray(checkpoint) &&
    checkpoint.length === 2 &&
    Array.isArray(checkpoint[0]) &&
    Array.isArray(checkpoint[1])
  );
}

/**
 * A configurable PubSub Topic.
 */
export class Topic<Value> extends BaseChannel<
  Array<Value>,
  Value | Value[],
  Value[]
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

  public fromCheckpoint(checkpoint?: Value[] | [Value[], Value[]]) {
    const empty = new Topic<Value>({
      unique: this.unique,
      accumulate: this.accumulate,
    });
    if (typeof checkpoint === "undefined") {
      return empty as this;
    }
    // Back-compat with pre-flat JS Topic checkpoints (`[seen, values]`),
    // matching Python Topic.from_checkpoint's tuple handling.
    if (isLegacyTopicCheckpoint<Value>(checkpoint)) {
      empty.seen = new Set(checkpoint[0]);
      empty.values = [...checkpoint[1]];
      return empty as this;
    }
    empty.values = [...checkpoint];
    // Flat checkpoints do not carry `seen`. Seed it from restored values so
    // `unique: true` still de-dupes against the current buffer after restore.
    if (this.unique) {
      empty.seen = new Set(empty.values);
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

  /**
   * Checkpoint as a flat values list (Python Topic parity).
   *
   * Previously returned `[seen, values]`, which Host's Python checkpointer
   * treated as a list of non-Send items and rejected for `__pregel_tasks`.
   */
  public checkpoint(): Value[] {
    return [...this.values];
  }

  isAvailable(): boolean {
    return this.values.length !== 0;
  }
}
