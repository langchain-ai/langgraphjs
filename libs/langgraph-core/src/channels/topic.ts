import { EmptyChannelError } from "../errors.js";
import { BaseChannel } from "./base.js";

/** JS Topic checkpoint when `unique` is set: `[seen, values]`. */
type UniqueTopicCheckpoint<Value> = [Value[], Value[]];

/**
 * Detect the `[seen, values]` Topic checkpoint shape.
 *
 * Used for `unique: true` topics (current) and pre-flat JS checkpoints
 * (legacy). Flat Python-parity checkpoints are a single values list.
 */
function isUniqueTopicCheckpoint<Value>(
  checkpoint: unknown
): checkpoint is UniqueTopicCheckpoint<Value> {
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
  Value[] | UniqueTopicCheckpoint<Value>
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

  public fromCheckpoint(checkpoint?: Value[] | UniqueTopicCheckpoint<Value>) {
    const empty = new Topic<Value>({
      unique: this.unique,
      accumulate: this.accumulate,
    });
    if (typeof checkpoint === "undefined") {
      return empty as this;
    }
    // `unique: true` (and legacy pre-flat) checkpoints are `[seen, values]`.
    if (isUniqueTopicCheckpoint<Value>(checkpoint)) {
      empty.seen = new Set(checkpoint[0]);
      empty.values = [...checkpoint[1]];
      return empty as this;
    }
    empty.values = [...checkpoint];
    // Flat checkpoints have no historical `seen`. Seed from the current
    // buffer so `unique: true` still de-dupes values present after restore.
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
   * Checkpoint Topic state.
   *
   * Default / Host path (`unique: false`, including `__pregel_tasks`): flat
   * values list, matching Python Topic. Previously this always returned
   * `[seen, values]`, so empty TASKS became `[[], []]` and Host's Python
   * checkpointer rejected it.
   *
   * When `unique: true`, keep `[seen, values]` so dedupe history that outlives
   * the current buffer still survives resume.
   */
  public checkpoint(): Value[] | UniqueTopicCheckpoint<Value> {
    if (this.unique) {
      return [[...this.seen], [...this.values]];
    }
    return [...this.values];
  }

  isAvailable(): boolean {
    return this.values.length !== 0;
  }
}
