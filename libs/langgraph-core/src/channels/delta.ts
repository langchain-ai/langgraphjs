import {
  type CheckpointPendingWrite,
  DeltaSnapshot,
  isDeltaSnapshot,
} from "@langchain/langgraph-checkpoint";
import {
  _getOverwriteValue,
  _isOverwriteValue,
  type OverwriteValue,
} from "../constants.js";
import { EmptyChannelError, InvalidUpdateError } from "../errors.js";
import { BaseChannel } from "./base.js";

/**
 * A batch reducer for use with {@link DeltaChannel}.
 *
 * Receives the current accumulated value and a batch of writes in one call,
 * returning the new accumulated value:
 * `reducer(state, [write1, write2, ...]) -> newState`.
 *
 * Reducers must be deterministic and batching-invariant (associative across
 * folds): applying two consecutive write batches separately must produce the
 * same state as applying their concatenation once:
 *
 * ```text
 * reducer(reducer(state, xs), ys) === reducer(state, xs.concat(ys))
 * ```
 *
 * This lets LangGraph replay checkpointed writes in larger batches than they
 * were originally produced without changing reconstructed state. If your
 * reducer is not associative, use {@link BinaryOperatorAggregate} instead —
 * `DeltaChannel` is not a drop-in replacement for every reducer.
 */
export type DeltaReducer<ValueType, UpdateType = unknown> = (
  state: ValueType,
  writes: UpdateType[]
) => ValueType;

type OverwriteOrValue<ValueType, UpdateType> =
  | OverwriteValue<ValueType>
  | UpdateType;

const isDeltaChannel = (
  value: BaseChannel
): value is DeltaChannel<unknown, unknown> => {
  return value != null && value.lc_graph_name === "DeltaChannel";
};

/**
 * Reducer channel that stores only a sentinel in checkpoint blobs and
 * reconstructs state by replaying ancestor writes through the reducer.
 *
 * `DeltaChannel` avoids re-serializing the full accumulated value at every
 * step. Instead of writing the value into `channel_values`, the channel is
 * omitted entirely and its state is reconstructed on read by walking the
 * ancestor chain and replaying the per-step writes through the reducer (see
 * {@link BaseCheckpointSaver.getDeltaChannelHistory}).
 *
 * Snapshot cadence is driven by two counters: a per-channel update count and
 * the total supersteps since the last snapshot. A full {@link DeltaSnapshot}
 * blob is written when EITHER the update count reaches `snapshotFrequency` OR
 * the supersteps count reaches the system-wide
 * `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` bound (default 5000), bounding replay
 * depth even for channels that stop receiving writes.
 *
 * @remarks Beta. The API and on-disk representation may change in future
 * releases. Threads written with `DeltaChannel` today are expected to remain
 * readable, but the surrounding contract (`getDeltaChannelHistory`, the
 * `DeltaSnapshot` blob shape, the `counters_since_delta_snapshot` metadata
 * field) is not yet stable.
 *
 * @example
 * ```typescript
 * import { Annotation } from "@langchain/langgraph";
 * import { DeltaChannel, messagesDeltaReducer } from "@langchain/langgraph";
 *
 * const State = Annotation.Root({
 *   messages: Annotation<BaseMessage[]>({
 *     reducer: () => [], // ignored; DeltaChannel is supplied below
 *   }),
 * });
 * ```
 */
export class DeltaChannel<
  ValueType = unknown,
  UpdateType = unknown,
> extends BaseChannel<
  ValueType,
  OverwriteOrValue<ValueType, UpdateType>,
  undefined
> {
  lc_graph_name = "DeltaChannel";

  /** `undefined` represents the Python `MISSING` sentinel (empty channel). */
  value: ValueType | undefined;

  reducer: DeltaReducer<ValueType, UpdateType>;

  snapshotFrequency: number;

  initialValueFactory: () => ValueType;

  constructor(
    reducer: DeltaReducer<ValueType, UpdateType>,
    options?: {
      snapshotFrequency?: number;
      initialValueFactory?: () => ValueType;
    }
  ) {
    super();
    const snapshotFrequency = options?.snapshotFrequency ?? 1000;
    if (!Number.isInteger(snapshotFrequency) || snapshotFrequency <= 0) {
      throw new Error(
        `snapshotFrequency must be a positive integer, got ${snapshotFrequency}`
      );
    }
    this.reducer = reducer;
    this.snapshotFrequency = snapshotFrequency;
    this.initialValueFactory =
      options?.initialValueFactory ?? (() => [] as ValueType);
    this.value = undefined;
  }

  public fromCheckpoint(checkpoint?: undefined | DeltaSnapshot | ValueType) {
    const empty = new DeltaChannel<ValueType, UpdateType>(this.reducer, {
      snapshotFrequency: this.snapshotFrequency,
      initialValueFactory: this.initialValueFactory,
    });
    if (checkpoint === undefined) {
      empty.value = this.initialValueFactory();
    } else if (isDeltaSnapshot(checkpoint)) {
      empty.value = checkpoint.value as ValueType;
    } else {
      empty.value = checkpoint as ValueType;
    }
    return empty as this;
  }

  /**
   * Replay ancestor writes grouped by super-step, oldest-to-newest.
   *
   * Each inner array holds the writes produced in a single super-step (as
   * returned by {@link BaseCheckpointSaver.getDeltaChannelHistory}). An
   * Overwrite anywhere in a super-step wins that whole step: its value becomes
   * the new base and every sibling write in the same step (before AND after)
   * is discarded. Steps without an Overwrite fold their writes through the
   * reducer. This mirrors {@link DeltaChannel.update} exactly, so a
   * reconstruction reproduces the live state for any per-step write order —
   * including concurrent (fan-in) writes whose ordering is not stable.
   */
  public replayWrites(steps: CheckpointPendingWrite[][]): void {
    let base =
      this.value === undefined ? this.initialValueFactory() : this.value;
    for (const step of steps) {
      if (step.length === 0) continue;
      let overwriteValue: ValueType | undefined;
      let hasOverwrite = false;
      const plain: UpdateType[] = [];
      for (const write of step) {
        const [isOverwrite, value] = _getOverwriteValue<ValueType>(write[2]);
        if (isOverwrite) {
          hasOverwrite = true;
          overwriteValue = value;
        } else {
          plain.push(write[2] as UpdateType);
        }
      }
      if (hasOverwrite) {
        base =
          overwriteValue !== undefined && overwriteValue !== null
            ? overwriteValue
            : this.initialValueFactory();
      } else if (plain.length > 0) {
        base = this.reducer(base, plain);
      }
    }
    this.value = base;
  }

  public update(values: OverwriteOrValue<ValueType, UpdateType>[]): boolean {
    if (values.length === 0) return false;

    let overwriteValue: ValueType | undefined;
    let hasOverwrite = false;
    for (const value of values) {
      if (_isOverwriteValue<ValueType>(value)) {
        if (hasOverwrite) {
          throw new InvalidUpdateError(
            "Can receive only one Overwrite value per step."
          );
        }
        hasOverwrite = true;
        [, overwriteValue] = _getOverwriteValue<ValueType>(value);
      }
    }

    if (hasOverwrite) {
      // Option A: an Overwrite wins the entire super-step. Every sibling write
      // in the same step — before AND after the Overwrite — is discarded, so
      // the result is independent of the (arbitrary) order of concurrent
      // writes within the step. This mirrors `BinaryOperatorAggregate` and is
      // why only one Overwrite per step is allowed.
      this.value =
        overwriteValue !== undefined && overwriteValue !== null
          ? overwriteValue
          : this.initialValueFactory();
      return true;
    }

    const base =
      this.value === undefined ? this.initialValueFactory() : this.value;
    this.value = this.reducer(base, values as UpdateType[]);
    return true;
  }

  public get(): ValueType {
    if (this.value === undefined) {
      throw new EmptyChannelError();
    }
    return this.value;
  }

  /**
   * Always returns `undefined` (the Python `MISSING` sentinel). Snapshot
   * decisions live in `createCheckpoint`, which has the channel version and
   * writes a {@link DeltaSnapshot} directly into `channel_values`. For
   * non-snapshot steps the channel does not appear in `channel_values`;
   * reconstruction walks ancestor writes via the saver's
   * `getDeltaChannelHistory`.
   */
  public checkpoint(): undefined {
    return undefined;
  }

  isAvailable(): boolean {
    return this.value !== undefined;
  }

  equals(other: BaseChannel): boolean {
    if (this === other) return true;
    if (!isDeltaChannel(other)) return false;
    if (this.snapshotFrequency !== other.snapshotFrequency) return false;
    return this.reducer === other.reducer;
  }
}
