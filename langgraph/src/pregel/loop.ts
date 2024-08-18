import { type RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  copyCheckpoint,
  emptyCheckpoint,
} from "../checkpoint/base.js";
import { BaseChannel, createCheckpoint } from "../channels/base.js";
import { PregelExecutableTask, PregelInterface } from "./types.js";
import {
  PendingWrite,
  CheckpointPendingWrite,
  CheckpointMetadata,
} from "../checkpoint/types.js";
import {
  CONFIG_KEY_READ,
  CONFIG_KEY_RESUMING,
  INPUT,
  INTERRUPT,
} from "../constants.js";
import {
  _applyWrites,
  _prepareNextTasks,
  shouldInterrupt,
  WritesProtocol,
} from "./algo.js";
import { gatherIterator, prefixGenerator } from "../utils.js";
import { mapInput, mapOutputUpdates, mapOutputValues } from "./io.js";
import { EmptyInputError, GraphInterrupt } from "../errors.js";
import { getNewChannelVersions } from "./utils.js";
import { mapDebugTasks, mapDebugCheckpoint } from "./debug.js";
import { PregelNode } from "./read.js";

const INPUT_DONE = Symbol.for("INPUT_DONE");
const INPUT_RESUMING = Symbol.for("INPUT_RESUMING");

export type PregelLoopInitializeParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  graph: PregelInterface<
    Record<string, PregelNode>,
    Record<string, BaseChannel>
  >;
};

type PregelLoopParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  graph: PregelInterface<
    Record<string, PregelNode>,
    Record<string, BaseChannel>
  >;
  checkpoint: Checkpoint;
  checkpointMetadata: CheckpointMetadata;
  checkpointPreviousVersions: Record<string, string | number>;
  checkpointPendingWrites: CheckpointPendingWrite[];
  checkpointConfig: RunnableConfig;
  channels: Record<string, BaseChannel>;
  step: number;
  stop: number;
};

export class PregelLoop {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected input?: any;

  protected config: RunnableConfig;

  protected checkpointer?: BaseCheckpointSaver;

  protected checkpointerGetNextVersion: (
    current: number | undefined,
    channel: BaseChannel
  ) => number;

  // TODO: Fix typing
  protected graph: PregelInterface<
    Record<string, PregelNode>,
    Record<string, BaseChannel>
  >;

  protected channels: Record<string, BaseChannel>;

  // TODO: Fix typing
  protected managed: Record<string, any>;

  protected checkpoint: Checkpoint;

  protected checkpointConfig: RunnableConfig;

  protected checkpointMetadata: CheckpointMetadata;

  protected checkpointPendingWrites: CheckpointPendingWrite[] = [];

  protected checkpointPreviousVersions: Record<string, string | number>;

  protected step: number;

  protected stop: number;

  protected status:
    | "pending"
    | "done"
    | "interrupt_before"
    | "interrupt_after"
    | "out_of_steps" = "pending";

  protected tasks: PregelExecutableTask<string, string>[] = [];

  protected stream: [string, any][] = [];

  protected isNested: boolean;

  protected _putCheckpointPromise: Promise<unknown> = Promise.resolve();

  constructor(params: PregelLoopParams) {
    this.input = params.input;
    this.config = params.config;
    this.checkpointer = params.checkpointer;
    // TODO: if managed values no longer needs graph we can replace with
    // managed_specs, channel_specs
    if (this.checkpointer !== undefined) {
      this.checkpointerGetNextVersion = this.checkpointer.getNextVersion.bind(
        this.checkpointer
      );
    } else {
      this.checkpointerGetNextVersion = (current) => {
        return current !== undefined ? current + 1 : 1;
      };
    }
    this.graph = params.graph;
    this.checkpoint = params.checkpoint;
    this.checkpointMetadata = params.checkpointMetadata;
    this.checkpointPreviousVersions = params.checkpointPreviousVersions;
    this.checkpointPendingWrites = params.checkpointPendingWrites;
    this.step = params.step;
    this.stop = params.stop;
    this.isNested = CONFIG_KEY_READ in (this.config.configurable ?? {});
  }

  protected static async initialize(params: PregelLoopInitializeParams) {
    const saved: CheckpointTuple = (await params.checkpointer?.getTuple(
      params.config
    )) ?? {
      config: params.config,
      checkpoint: emptyCheckpoint(),
      metadata: {
        source: "input",
        step: -2,
        writes: null,
      },
      pendingWrites: [],
    };
    const checkpointConfig = {
      ...params.config,
      ...saved.config,
      configurable: {
        ...params.config.configurable,
        ...saved.config.configurable,
      },
    };
    const checkpoint = copyCheckpoint(saved.checkpoint);
    const checkpointMetadata = { ...saved.metadata } as CheckpointMetadata;
    const checkpointPendingWrites = saved.pendingWrites ?? [];

    const channels = Object.entries(params.graph.channels).reduce(
      (channels: Record<string, BaseChannel>, [k, v]) => {
        // eslint-disable-next-line no-param-reassign
        channels[k] = v.fromCheckpoint(checkpoint.channel_values[k]);
        return channels;
      },
      {}
    );

    const step = (checkpointMetadata.step ?? 0) + 1;
    const stop = step + (params.config.recursionLimit ?? 25) + 1;
    const checkpointPreviousVersions = { ...checkpoint.channel_versions };
    return new PregelLoop({
      input: params.input,
      config: params.config,
      checkpointer: params.checkpointer,
      graph: params.graph,
      checkpoint,
      checkpointMetadata,
      checkpointConfig,
      channels,
      step,
      stop,
      checkpointPreviousVersions,
      checkpointPendingWrites,
    });
  }

  protected async _checkpointerPutAfterPrevious(input: {
    config: RunnableConfig;
    checkpoint: Checkpoint;
    metadata: CheckpointMetadata;
    newVersions: Record<string, string | number>;
  }) {
    try {
      await this._putCheckpointPromise;
    } finally {
      this._putCheckpointPromise =
        this.checkpointer?.put(
          input.config,
          input.checkpoint,
          input.metadata
        ) ?? Promise.resolve();
    }
  }

  /**
   * Put writes for a task, to be read by the next tick.
   * @param taskId
   * @param writes
   */
  putWrites(taskId: string, writes: PendingWrite<string>[]) {
    const pendingWrites: CheckpointPendingWrite<string>[] = writes.map(
      ([key, value]) => {
        return [taskId, key, value];
      }
    );
    this.checkpointPendingWrites.push(...pendingWrites);
    if (this.checkpointer !== undefined) {
      void this.checkpointer.putWrites(
        {
          ...this.checkpointConfig,
          configurable: {
            ...this.checkpointConfig.configurable,
            checkpoint_ns: this.config.configurable?.checkpoint_ns ?? "",
            checkpoint_id: this.checkpoint.id,
          },
        },
        writes,
        taskId
      );
    }
  }

  /**
   * Execute a single iteration of the Pregel loop.
   * Returns true if more iterations are needed.
   * @param params
   */
  async tick(params: {
    outputKeys: string | string[];
    interruptAfter: string[];
    interruptBefore: string[];
    manager?: any;
  }): Promise<boolean> {
    const {
      outputKeys = [],
      interruptAfter = [],
      interruptBefore = [],
      manager,
    } = params;
    if (this.status !== "pending") {
      throw new Error(
        `Cannot tick when status is no longer "pending". Current status: "${this.status}"`
      );
    }
    if (![INPUT_DONE, INPUT_RESUMING].includes(this.input)) {
      await this._first();
    } else if (this.tasks.every((task) => task.writes.length > 0)) {
      const writes = this.tasks.flatMap((t) => t.writes);
      // All tasks have finished
      _applyWrites(this.checkpoint, this.channels, this.tasks);
      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(outputKeys, writes, this.channels),
          "values"
        )
      );
      this.stream.push(...valuesOutput);
      // clear pending writes
      this.checkpointPendingWrites = [];
      const metadataWrites =
        this.graph.streamMode === "updates"
          ? mapOutputUpdates(outputKeys, this.tasks).next().value
          : mapOutputValues(outputKeys, writes, this.channels).next().value;
      void this._putCheckpoint({
        source: "loop",
        writes: metadataWrites,
      });
      // after execution, check if we should interrupt
      if (shouldInterrupt(this.checkpoint, interruptAfter, this.tasks)) {
        this.status = "interrupt_after";
        if (this.isNested) {
          throw new GraphInterrupt();
        } else {
          return false;
        }
      }
    } else {
      return false;
    }
    if (this.step > this.stop) {
      this.status = "out_of_steps";
      return false;
    }

    const [, nextTasks] = _prepareNextTasks(
      this.checkpoint,
      this.graph.nodes,
      this.channels,
      this.config,
      true,
      {
        step: this.step,
        checkpointer: this.checkpointer,
        isResuming: this.input === INPUT_RESUMING,
      }
    );
    this.tasks = nextTasks;
    if (this.tasks.length === 0) {
      this.status = "done";
      return false;
    }
    // if there are pending writes from a previous loop, apply them
    if (this.checkpointPendingWrites.length > 0) {
      for (const [tid, k, v] of this.checkpointPendingWrites) {
        const task = this.tasks.find((t) => t.id === tid);
        if (task) {
          task.writes.push([k, v]);
        }
      }
    }
    // if all tasks have finished, re-tick
    if (this.tasks.every((task) => task.writes.length > 0)) {
      return this.tick({
        outputKeys,
        interruptAfter,
        interruptBefore,
        manager,
      });
    }

    // Before execution, check if we should interrupt
    if (shouldInterrupt(this.checkpoint, interruptBefore, this.tasks)) {
      this.status = "interrupt_before";
      if (this.isNested) {
        throw new GraphInterrupt();
      } else {
        return false;
      }
    }
    // Produce debug output
    const debugOutput = await gatherIterator(
      prefixGenerator(mapDebugTasks(this.step, this.tasks), "debug")
    );
    this.stream.push(...debugOutput);

    return true;
  }

  /**
   * Resuming from previous checkpoint requires
   * - finding a previous checkpoint
   * - receiving None input (outer graph) or RESUMING flag (subgraph)
   */
  protected async _first() {
    const isResuming =
      (Object.keys(this.checkpoint.channel_versions).length !== 0 &&
        this.config.configurable?.[CONFIG_KEY_RESUMING] !== undefined) ||
      this.input === undefined;
    if (isResuming) {
      for (const channelName of Object.keys(this.channels)) {
        if (this.checkpoint.channel_versions[channelName] !== undefined) {
          const version = this.checkpoint.channel_versions[channelName];
          this.checkpoint.versions_seen[INTERRUPT] = {
            ...this.checkpoint.versions_seen[INTERRUPT],
            [channelName]: version,
          };
        }
      }
      // map inputs to channel updates
    } else {
      const inputWrites = await gatherIterator(
        mapInput(this.graph.inputs, this.input)
      );
      if (inputWrites.length === 0) {
        throw new EmptyInputError(
          `Received no input writes for ${JSON.stringify(
            this.graph.inputs,
            null,
            2
          )}`
        );
      }
      const [, discardTasks] = _prepareNextTasks(
        this.checkpoint,
        this.graph.nodes,
        this.channels,
        this.config,
        true,
        { step: this.step }
      );
      _applyWrites(
        this.checkpoint,
        this.channels,
        (discardTasks as WritesProtocol[]).concat([
          {
            name: INPUT,
            writes: inputWrites,
            triggers: [],
          },
        ]),
        this.checkpointerGetNextVersion
      );
      // save input checkpoint
      void this._putCheckpoint({ source: "input", writes: this.input });
    }
    // done with input
    this.input = isResuming ? INPUT_RESUMING : INPUT_DONE;
  }

  protected async _putCheckpoint(
    inputMetadata: Omit<CheckpointMetadata, "step">
  ) {
    // Assign step
    const metadata = {
      ...inputMetadata,
      step: this.step,
    };
    // Bail if no checkpointer
    if (this.checkpointer !== undefined) {
      // create new checkpoint
      this.checkpointMetadata = metadata;
      // child graphs keep at most one checkpoint per parent checkpoint
      // this is achieved by writing child checkpoints as progress is made
      // (so that error recovery / resuming from interrupt don't lose work)
      // but doing so always with an id equal to that of the parent checkpoint
      this.checkpoint = createCheckpoint(
        this.checkpoint,
        this.channels,
        this.step
        // id: this.isNested ? this.config.configurable?.checkpoint_id : undefined,
      );
      this.checkpointConfig = {
        ...this.checkpointConfig,
        configurable: {
          ...this.checkpointConfig.configurable,
          checkpoint_ns: this.config.configurable?.checkpoint_ns ?? "",
        },
      };
      const channelVersions = { ...this.checkpoint.channel_versions };
      const newVersions = getNewChannelVersions(
        this.checkpointPreviousVersions,
        channelVersions
      );
      this.checkpointPreviousVersions = channelVersions;
      // save it, without blocking
      // if there's a previous checkpoint save in progress, wait for it
      // ensuring checkpointers receive checkpoints in order
      const putParams = {
        config: { ...this.checkpointConfig },
        checkpoint: copyCheckpoint(this.checkpoint),
        metadata: { ...this.checkpointMetadata },
        newVersions,
      };
      void this._checkpointerPutAfterPrevious(putParams);
      this.checkpointConfig = {
        ...this.checkpointConfig,
        configurable: {
          ...this.checkpointConfig.configurable,
          checkpoint_id: this.checkpoint.id,
        },
      };

      // Produce debug output
      const debugOutput = await gatherIterator(
        prefixGenerator(
          mapDebugCheckpoint(
            this.step,
            this.checkpointConfig,
            this.channels,
            this.graph.streamChannelsAsIs,
            this.checkpointMetadata
          ),
          "debug"
        )
      );
      this.stream.push(...debugOutput);
    }
    this.step += 1;
  }

  protected _suppressInterrupt(error: Error) {
    return error.name === GraphInterrupt.unminifiable_name && !this.isNested;
  }
}
