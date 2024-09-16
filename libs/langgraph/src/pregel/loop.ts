import Deque from "double-ended-queue";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointTuple,
  copyCheckpoint,
  emptyCheckpoint,
  PendingWrite,
  CheckpointPendingWrite,
  CheckpointMetadata,
  All,
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
} from "../channels/base.js";
import { PregelExecutableTask, StreamMode } from "./types.js";
import {
  CONFIG_KEY_READ,
  CONFIG_KEY_RESUMING,
  ERROR,
  INPUT,
  INTERRUPT,
} from "../constants.js";
import {
  _applyWrites,
  _prepareNextTasks,
  increment,
  shouldInterrupt,
  WritesProtocol,
} from "./algo.js";
import {
  gatherIterator,
  gatherIteratorSync,
  prefixGenerator,
} from "../utils.js";
import { mapInput, mapOutputUpdates, mapOutputValues } from "./io.js";
import { EmptyInputError, GraphInterrupt } from "../errors.js";
import { getNewChannelVersions } from "./utils.js";
import {
  mapDebugTasks,
  mapDebugCheckpoint,
  mapDebugTaskResults,
} from "./debug.js";
import { PregelNode } from "./read.js";
import { BaseStore } from "../store/base.js";
import { AsyncBatchedStore } from "../store/batch.js";
import { ManagedValueMapping, WritableManagedValue } from "../managed/base.js";

const INPUT_DONE = Symbol.for("INPUT_DONE");
const INPUT_RESUMING = Symbol.for("INPUT_RESUMING");
const DEFAULT_LOOP_LIMIT = 25;

export type PregelLoopInitializeParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  outputKeys: string | string[];
  streamKeys: string | string[];
  nodes: Record<string, PregelNode>;
  channelSpecs: Record<string, BaseChannel>;
  managed: ManagedValueMapping;
  store?: BaseStore;
};

type PregelLoopParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  checkpoint: Checkpoint;
  checkpointMetadata: CheckpointMetadata;
  checkpointPreviousVersions: Record<string, string | number>;
  checkpointPendingWrites: CheckpointPendingWrite[];
  checkpointConfig: RunnableConfig;
  channels: Record<string, BaseChannel>;
  managed: ManagedValueMapping;
  step: number;
  stop: number;
  outputKeys: string | string[];
  streamKeys: string | string[];
  nodes: Record<string, PregelNode>;
  store?: AsyncBatchedStore;
};

export class PregelLoop {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected input?: any;

  config: RunnableConfig;

  protected checkpointer?: BaseCheckpointSaver;

  protected checkpointerGetNextVersion: (
    current: number | undefined,
    channel: BaseChannel
  ) => number;

  channels: Record<string, BaseChannel>;

  managed: ManagedValueMapping;

  protected checkpoint: Checkpoint;

  protected checkpointConfig: RunnableConfig;

  checkpointMetadata: CheckpointMetadata;

  protected checkpointPendingWrites: CheckpointPendingWrite[] = [];

  protected checkpointPreviousVersions: Record<string, string | number>;

  step: number;

  protected stop: number;

  protected outputKeys: string | string[];

  protected streamKeys: string | string[];

  protected nodes: Record<string, PregelNode>;

  protected skipDoneTasks: boolean;

  status:
    | "pending"
    | "done"
    | "interrupt_before"
    | "interrupt_after"
    | "out_of_steps" = "pending";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: PregelExecutableTask<any, any>[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: Deque<[StreamMode, any]> = new Deque();

  checkpointerPromises: Promise<unknown>[] = [];

  protected isNested: boolean;

  protected _checkpointerChainedPromise: Promise<unknown> = Promise.resolve();

  store?: AsyncBatchedStore;

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
      this.checkpointerGetNextVersion = increment;
    }
    this.checkpoint = params.checkpoint;
    this.checkpointConfig = params.checkpointConfig;
    this.checkpointMetadata = params.checkpointMetadata;
    this.checkpointPreviousVersions = params.checkpointPreviousVersions;
    this.channels = params.channels;
    this.managed = params.managed;
    this.checkpointPendingWrites = params.checkpointPendingWrites;
    this.step = params.step;
    this.stop = params.stop;
    this.isNested = CONFIG_KEY_READ in (this.config.configurable ?? {});
    this.outputKeys = params.outputKeys;
    this.streamKeys = params.streamKeys;
    this.nodes = params.nodes;
    this.skipDoneTasks = this.config.configurable?.checkpoint_id === undefined;
    this.store = params.store;
  }

  static async initialize(params: PregelLoopInitializeParams) {
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

    const channels = emptyChannels(params.channelSpecs, checkpoint);

    const step = (checkpointMetadata.step ?? 0) + 1;
    const stop =
      step + (params.config.recursionLimit ?? DEFAULT_LOOP_LIMIT) + 1;
    const checkpointPreviousVersions = { ...checkpoint.channel_versions };

    const store = params.store
      ? new AsyncBatchedStore(params.store)
      : undefined;
    if (store) {
      // Start the store. This is a batch store, so it will run continuously
      store.start();
    }

    return new PregelLoop({
      input: params.input,
      config: params.config,
      checkpointer: params.checkpointer,
      checkpoint,
      checkpointMetadata,
      checkpointConfig,
      channels,
      managed: params.managed,
      step,
      stop,
      checkpointPreviousVersions,
      checkpointPendingWrites,
      outputKeys: params.outputKeys ?? [],
      streamKeys: params.streamKeys ?? [],
      nodes: params.nodes,
      store,
    });
  }

  protected _checkpointerPutAfterPrevious(input: {
    config: RunnableConfig;
    checkpoint: Checkpoint;
    metadata: CheckpointMetadata;
    newVersions: Record<string, string | number>;
  }) {
    this._checkpointerChainedPromise = this._checkpointerChainedPromise.then(
      () => {
        return this.checkpointer?.put(
          input.config,
          input.checkpoint,
          input.metadata,
          input.newVersions
        );
      }
    );
    this.checkpointerPromises.push(this._checkpointerChainedPromise);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async updateManagedValues(key: string, values: any[]) {
    const mv = this.managed.get(key);
    if (mv && "update" in mv && typeof mv.update === "function") {
      await (mv as WritableManagedValue).update(values);
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
    const putWritePromise = this.checkpointer?.putWrites(
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
    if (putWritePromise !== undefined) {
      this.checkpointerPromises.push(putWritePromise);
    }
    const task = this.tasks.find((task) => task.id === taskId);
    if (task !== undefined) {
      this.stream.push(
        ...gatherIteratorSync(
          prefixGenerator(mapOutputUpdates(this.outputKeys, [task]), "updates")
        )
      );
      this.stream.push(
        ...gatherIteratorSync(
          prefixGenerator(
            mapDebugTaskResults(this.step, [[task, writes]], this.streamKeys),
            "debug"
          )
        )
      );
    }
  }

  /**
   * Execute a single iteration of the Pregel loop.
   * Returns true if more iterations are needed.
   * @param params
   */
  async tick(params: {
    inputKeys?: string | string[];
    interruptAfter: string[] | All;
    interruptBefore: string[] | All;
    manager?: CallbackManagerForChainRun;
  }): Promise<boolean> {
    if (this.store && !this.store.isRunning) {
      this.store?.start();
    }
    const {
      inputKeys = [],
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
      await this._first(inputKeys);
    } else if (this.tasks.every((task) => task.writes.length > 0)) {
      const writes = this.tasks.flatMap((t) => t.writes);
      // All tasks have finished
      const myWrites = _applyWrites(
        this.checkpoint,
        this.channels,
        this.tasks,
        this.checkpointerGetNextVersion
      );
      for (const [key, values] of Object.entries(myWrites)) {
        await this.updateManagedValues(key, values);
      }
      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(this.outputKeys, writes, this.channels),
          "values"
        )
      );
      this.stream.push(...valuesOutput);
      // clear pending writes
      this.checkpointPendingWrites = [];
      await this._putCheckpoint({
        source: "loop",
        writes:
          mapOutputUpdates(this.outputKeys, this.tasks).next().value ?? null,
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

    const nextTasks = _prepareNextTasks(
      this.checkpoint,
      this.nodes,
      this.channels,
      this.managed,
      this.config,
      true,
      {
        step: this.step,
        checkpointer: this.checkpointer,
        isResuming: this.input === INPUT_RESUMING,
        manager,
      }
    );
    this.tasks = nextTasks;

    // Produce debug output
    if (this.checkpointer) {
      this.stream.push(
        ...(await gatherIterator(
          prefixGenerator(
            mapDebugCheckpoint(
              this.step - 1, // printing checkpoint for previous step
              this.checkpointConfig,
              this.channels,
              this.streamKeys,
              this.checkpointMetadata,
              this.tasks,
              this.checkpointPendingWrites
            ),
            "debug"
          )
        ))
      );
    }

    if (this.tasks.length === 0) {
      this.status = "done";
      return false;
    }
    // if there are pending writes from a previous loop, apply them
    if (this.checkpointPendingWrites.length > 0 && this.skipDoneTasks) {
      for (const [tid, k, v] of this.checkpointPendingWrites) {
        if (k === ERROR || k === INTERRUPT) {
          continue;
        }
        const task = this.tasks.find((t) => t.id === tid);
        if (task) {
          task.writes.push([k, v]);
        }
      }
    }
    // if all tasks have finished, re-tick
    if (this.tasks.every((task) => task.writes.length > 0)) {
      return this.tick({
        inputKeys,
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
  protected async _first(inputKeys: string | string[]) {
    const isResuming =
      (Object.keys(this.checkpoint.channel_versions).length !== 0 &&
        this.config.configurable?.[CONFIG_KEY_RESUMING] !== undefined) ||
      this.input === null;
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
      const inputWrites = await gatherIterator(mapInput(inputKeys, this.input));
      if (inputWrites.length === 0) {
        throw new EmptyInputError(
          `Received no input writes for ${JSON.stringify(inputKeys, null, 2)}`
        );
      }
      const discardTasks = _prepareNextTasks(
        this.checkpoint,
        this.nodes,
        this.channels,
        this.managed,
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
            writes: inputWrites as PendingWrite[],
            triggers: [],
          },
        ]),
        this.checkpointerGetNextVersion
      );
      // save input checkpoint
      await this._putCheckpoint({
        source: "input",
        writes: Object.fromEntries(inputWrites),
      });
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
      void this._checkpointerPutAfterPrevious({
        config: { ...this.checkpointConfig },
        checkpoint: copyCheckpoint(this.checkpoint),
        metadata: { ...this.checkpointMetadata },
        newVersions,
      });
      this.checkpointConfig = {
        ...this.checkpointConfig,
        configurable: {
          ...this.checkpointConfig.configurable,
          checkpoint_id: this.checkpoint.id,
        },
      };
    }
    this.step += 1;
  }
}
