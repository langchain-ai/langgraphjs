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
  BaseStore,
  AsyncBatchedStore,
  WRITES_IDX_MAP,
  BaseCache,
  CacheFullKey,
  CacheNamespace,
} from "@langchain/langgraph-checkpoint";

import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
} from "../channels/base.js";
import type {
  Call,
  CallTaskPath,
  Durability,
  PregelExecutableTask,
  PregelScratchpad,
  StreamMode,
} from "./types.js";
import {
  isCommand,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Command,
  CONFIG_KEY_CHECKPOINT_MAP,
  CONFIG_KEY_READ,
  CONFIG_KEY_RESUMING,
  CONFIG_KEY_STREAM,
  ERROR,
  INPUT,
  INTERRUPT,
  NULL_TASK_ID,
  RESUME,
  TAG_HIDDEN,
  PUSH,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_CHECKPOINT_NS,
  CHECKPOINT_NAMESPACE_END,
  CONFIG_KEY_CHECKPOINT_ID,
  CONFIG_KEY_RESUME_MAP,
  START,
} from "../constants.js";
import {
  _applyWrites,
  _prepareNextTasks,
  _prepareSingleTask,
  increment,
  shouldInterrupt,
  WritesProtocol,
} from "./algo.js";
import {
  gatherIterator,
  gatherIteratorSync,
  prefixGenerator,
} from "../utils.js";
import {
  mapCommand,
  mapInput,
  mapOutputUpdates,
  mapOutputValues,
  readChannels,
} from "./io.js";
import {
  EmptyInputError,
  GraphInterrupt,
  isGraphInterrupt,
} from "../errors.js";
import { getNewChannelVersions, patchConfigurable } from "./utils/index.js";
import {
  mapDebugTasks,
  mapDebugCheckpoint,
  mapDebugTaskResults,
  printStepTasks,
} from "./debug.js";
import { PregelNode } from "./read.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
import { IterableReadableWritableStream, StreamChunk } from "./stream.js";
import { isXXH3 } from "../hash.js";

const INPUT_DONE = Symbol.for("INPUT_DONE");
const INPUT_RESUMING = Symbol.for("INPUT_RESUMING");
const DEFAULT_LOOP_LIMIT = 25;

export type PregelLoopInitializeParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any | Command;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  outputKeys: string | string[];
  streamKeys: string | string[];
  nodes: Record<string, PregelNode>;
  channelSpecs: Record<string, BaseChannel>;
  stream: IterableReadableWritableStream;
  store?: BaseStore;
  cache?: BaseCache<PendingWrite<string>[]>;
  interruptAfter: string[] | All;
  interruptBefore: string[] | All;
  durability: Durability;
  manager?: CallbackManagerForChainRun;
  debug: boolean;
  triggerToNodes: Record<string, string[]>;
};

type PregelLoopParams = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: any | Command;
  config: RunnableConfig;
  checkpointer?: BaseCheckpointSaver;
  checkpoint: Checkpoint;
  checkpointMetadata: CheckpointMetadata;
  checkpointPreviousVersions: Record<string, string | number>;
  checkpointPendingWrites: CheckpointPendingWrite[];
  checkpointConfig: RunnableConfig;
  channels: Record<string, BaseChannel>;
  step: number;
  stop: number;
  outputKeys: string | string[];
  streamKeys: string | string[];
  nodes: Record<string, PregelNode>;
  checkpointNamespace: string[];
  skipDoneTasks: boolean;
  isNested: boolean;
  manager?: CallbackManagerForChainRun;
  stream: IterableReadableWritableStream;
  store?: AsyncBatchedStore;
  cache?: BaseCache<PendingWrite<string>[]>;
  prevCheckpointConfig: RunnableConfig | undefined;
  interruptAfter: string[] | All;
  interruptBefore: string[] | All;
  durability: Durability;
  debug: boolean;
  triggerToNodes: Record<string, string[]>;
};

function createDuplexStream(...streams: IterableReadableWritableStream[]) {
  return new IterableReadableWritableStream({
    passthroughFn: (value: StreamChunk) => {
      for (const stream of streams) {
        if (stream.modes.has(value[1])) {
          stream.push(value);
        }
      }
    },
    modes: new Set(streams.flatMap((s) => Array.from(s.modes))),
  });
}

class AsyncBatchedCache extends BaseCache<PendingWrite<string>[]> {
  protected cache: BaseCache<PendingWrite<string>[]>;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(cache: BaseCache<unknown>) {
    super();
    this.cache = cache as BaseCache<PendingWrite<string>[]>;
  }

  async get(keys: CacheFullKey[]) {
    return this.enqueueOperation("get", keys);
  }

  async set(
    pairs: {
      key: CacheFullKey;
      value: PendingWrite<string>[];
      ttl?: number;
    }[]
  ) {
    return this.enqueueOperation("set", pairs);
  }

  async clear(namespaces: CacheNamespace[]) {
    return this.enqueueOperation("clear", namespaces);
  }

  async stop() {
    await this.queue;
  }

  private enqueueOperation<Type extends "get" | "set" | "clear">(
    type: Type,
    ...args: Parameters<(typeof this.cache)[Type]>
  ) {
    const newPromise = this.queue.then(() => {
      // @ts-expect-error Tuple type warning
      return this.cache[type](...args) as Promise<
        ReturnType<(typeof this.cache)[Type]>
      >;
    });

    this.queue = newPromise.then(
      () => void 0,
      () => void 0
    );

    return newPromise;
  }
}

export class PregelLoop {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected input?: any | Command;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;

  config: LangGraphRunnableConfig;

  protected checkpointer?: BaseCheckpointSaver;

  protected checkpointerGetNextVersion: (current: number | undefined) => number;

  channels: Record<string, BaseChannel>;

  protected checkpoint: Checkpoint;

  protected checkpointIdSaved: string | undefined;

  protected checkpointConfig: RunnableConfig;

  checkpointMetadata: CheckpointMetadata;

  protected checkpointNamespace: string[];

  protected checkpointPendingWrites: CheckpointPendingWrite[] = [];

  protected checkpointPreviousVersions: Record<string, string | number>;

  step: number;

  protected stop: number;

  protected durability: Durability;

  protected outputKeys: string | string[];

  protected streamKeys: string | string[];

  protected nodes: Record<string, PregelNode>;

  protected skipDoneTasks: boolean;

  protected prevCheckpointConfig: RunnableConfig | undefined;

  status:
    | "pending"
    | "done"
    | "interrupt_before"
    | "interrupt_after"
    | "out_of_steps" = "pending";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Record<string, PregelExecutableTask<any, any>> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: IterableReadableWritableStream;

  checkpointerPromises: Promise<unknown>[] = [];

  isNested: boolean;

  protected _checkpointerChainedPromise: Promise<unknown> = Promise.resolve();

  store?: AsyncBatchedStore;

  cache?: AsyncBatchedCache;

  manager?: CallbackManagerForChainRun;

  interruptAfter: string[] | All;

  interruptBefore: string[] | All;

  toInterrupt: PregelExecutableTask<string, string>[] = [];

  debug: boolean = false;

  triggerToNodes: Record<string, string[]>;

  get isResuming() {
    let hasChannelVersions = false;
    if (START in this.checkpoint.channel_versions) {
      // For common channels, we can short-circuit the check
      hasChannelVersions = true;
    } else {
      for (const chan in this.checkpoint.channel_versions) {
        if (
          Object.prototype.hasOwnProperty.call(
            this.checkpoint.channel_versions,
            chan
          )
        ) {
          hasChannelVersions = true;
          break;
        }
      }
    }

    const configHasResumingFlag =
      this.config.configurable?.[CONFIG_KEY_RESUMING] !== undefined;
    const configIsResuming =
      configHasResumingFlag && this.config.configurable?.[CONFIG_KEY_RESUMING];

    const inputIsNullOrUndefined =
      this.input === null || this.input === undefined;
    const inputIsCommandResuming =
      isCommand(this.input) && this.input.resume != null;
    const inputIsResuming = this.input === INPUT_RESUMING;

    const runIdMatchesPrevious =
      !this.isNested &&
      this.config.metadata?.run_id !== undefined &&
      (this.checkpointMetadata as { run_id?: unknown })?.run_id !== undefined &&
      this.config.metadata.run_id ===
        (this.checkpointMetadata as { run_id?: unknown })?.run_id;

    return (
      hasChannelVersions &&
      (configIsResuming ||
        inputIsNullOrUndefined ||
        inputIsCommandResuming ||
        inputIsResuming ||
        runIdMatchesPrevious)
    );
  }

  constructor(params: PregelLoopParams) {
    this.input = params.input;
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
    this.checkpointMetadata = params.checkpointMetadata;
    this.checkpointPreviousVersions = params.checkpointPreviousVersions;
    this.channels = params.channels;
    this.checkpointPendingWrites = params.checkpointPendingWrites;
    this.step = params.step;
    this.stop = params.stop;
    this.config = params.config;
    this.checkpointConfig = params.checkpointConfig;
    this.isNested = params.isNested;
    this.manager = params.manager;
    this.outputKeys = params.outputKeys;
    this.streamKeys = params.streamKeys;
    this.nodes = params.nodes;
    this.skipDoneTasks = params.skipDoneTasks;
    this.store = params.store;
    this.cache = params.cache ? new AsyncBatchedCache(params.cache) : undefined;
    this.stream = params.stream;
    this.checkpointNamespace = params.checkpointNamespace;
    this.prevCheckpointConfig = params.prevCheckpointConfig;
    this.interruptAfter = params.interruptAfter;
    this.interruptBefore = params.interruptBefore;
    this.durability = params.durability;
    this.debug = params.debug;
    this.triggerToNodes = params.triggerToNodes;
  }

  static async initialize(params: PregelLoopInitializeParams) {
    let { config, stream } = params;
    if (
      stream !== undefined &&
      config.configurable?.[CONFIG_KEY_STREAM] !== undefined
    ) {
      stream = createDuplexStream(
        stream,
        config.configurable[CONFIG_KEY_STREAM]
      );
    }
    const skipDoneTasks = config.configurable
      ? !("checkpoint_id" in config.configurable)
      : true;

    const scratchpad = config.configurable?.[CONFIG_KEY_SCRATCHPAD] as
      | PregelScratchpad
      | undefined;

    if (config.configurable && scratchpad) {
      if (scratchpad.subgraphCounter > 0) {
        config = patchConfigurable(config, {
          [CONFIG_KEY_CHECKPOINT_NS]: [
            config.configurable[CONFIG_KEY_CHECKPOINT_NS],
            scratchpad.subgraphCounter.toString(),
          ].join(CHECKPOINT_NAMESPACE_SEPARATOR),
        });
      }

      scratchpad.subgraphCounter += 1;
    }

    const isNested = CONFIG_KEY_READ in (config.configurable ?? {});
    if (
      !isNested &&
      config.configurable?.checkpoint_ns !== undefined &&
      config.configurable?.checkpoint_ns !== ""
    ) {
      config = patchConfigurable(config, {
        checkpoint_ns: "",
        checkpoint_id: undefined,
      });
    }
    let checkpointConfig = config;
    if (
      config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP] !== undefined &&
      config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP]?.[
        config.configurable?.checkpoint_ns
      ]
    ) {
      checkpointConfig = patchConfigurable(config, {
        checkpoint_id:
          config.configurable[CONFIG_KEY_CHECKPOINT_MAP][
            config.configurable?.checkpoint_ns
          ],
      });
    }
    const checkpointNamespace =
      config.configurable?.checkpoint_ns?.split(
        CHECKPOINT_NAMESPACE_SEPARATOR
      ) ?? [];

    const saved: CheckpointTuple = (await params.checkpointer?.getTuple(
      checkpointConfig
    )) ?? {
      config,
      checkpoint: emptyCheckpoint(),
      metadata: { source: "input", step: -2, parents: {} },
      pendingWrites: [],
    };
    checkpointConfig = {
      ...config,
      ...saved.config,
      configurable: {
        checkpoint_ns: "",
        ...config.configurable,
        ...saved.config.configurable,
      },
    };
    const prevCheckpointConfig = saved.parentConfig;
    const checkpoint = copyCheckpoint(saved.checkpoint);
    const checkpointMetadata = { ...saved.metadata } as CheckpointMetadata;
    const checkpointPendingWrites = saved.pendingWrites ?? [];

    const channels = emptyChannels(params.channelSpecs, checkpoint);

    const step = (checkpointMetadata.step ?? 0) + 1;
    const stop = step + (config.recursionLimit ?? DEFAULT_LOOP_LIMIT) + 1;
    const checkpointPreviousVersions = { ...checkpoint.channel_versions };

    const store = params.store
      ? new AsyncBatchedStore(params.store)
      : undefined;

    if (store) {
      // Start the store. This is a batch store, so it will run continuously
      await store.start();
    }
    return new PregelLoop({
      input: params.input,
      config,
      checkpointer: params.checkpointer,
      checkpoint,
      checkpointMetadata,
      checkpointConfig,
      prevCheckpointConfig,
      checkpointNamespace,
      channels,
      isNested,
      manager: params.manager,
      skipDoneTasks,
      step,
      stop,
      checkpointPreviousVersions,
      checkpointPendingWrites,
      outputKeys: params.outputKeys ?? [],
      streamKeys: params.streamKeys ?? [],
      nodes: params.nodes,
      stream,
      store,
      cache: params.cache,
      interruptAfter: params.interruptAfter,
      interruptBefore: params.interruptBefore,
      durability: params.durability,
      debug: params.debug,
      triggerToNodes: params.triggerToNodes,
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

  /**
   * Put writes for a task, to be read by the next tick.
   * @param taskId
   * @param writes
   */
  putWrites(taskId: string, writes: PendingWrite<string>[]) {
    let writesCopy = writes;
    if (writesCopy.length === 0) return;

    // deduplicate writes to special channels, last write wins
    if (writesCopy.every(([key]) => key in WRITES_IDX_MAP)) {
      writesCopy = Array.from(
        new Map(writesCopy.map((w) => [w[0], w])).values()
      );
    }

    // remove existing writes for this task
    this.checkpointPendingWrites = this.checkpointPendingWrites.filter(
      (w) => w[0] !== taskId
    );

    // save writes
    for (const [c, v] of writesCopy) {
      this.checkpointPendingWrites.push([taskId, c, v]);
    }

    const config = patchConfigurable(this.checkpointConfig, {
      [CONFIG_KEY_CHECKPOINT_NS]: this.config.configurable?.checkpoint_ns ?? "",
      [CONFIG_KEY_CHECKPOINT_ID]: this.checkpoint.id,
    });

    if (this.durability !== "exit" && this.checkpointer != null) {
      this.checkpointerPromises.push(
        this.checkpointer.putWrites(config, writesCopy, taskId)
      );
    }

    if (this.tasks) {
      this._outputWrites(taskId, writesCopy);
    }

    if (!writes.length || !this.cache || !this.tasks) {
      return;
    }

    // only cache tasks with a cache key
    const task = this.tasks[taskId];
    if (task == null || task.cache_key == null) {
      return;
    }

    // only cache successful tasks
    if (writes[0][0] === ERROR || writes[0][0] === INTERRUPT) {
      return;
    }

    void this.cache.set([
      {
        key: [task.cache_key.ns, task.cache_key.key],
        value: task.writes,
        ttl: task.cache_key.ttl,
      },
    ]);
  }

  _outputWrites(taskId: string, writes: [string, unknown][], cached = false) {
    const task = this.tasks[taskId];
    if (task !== undefined) {
      if (
        task.config !== undefined &&
        (task.config.tags ?? []).includes(TAG_HIDDEN)
      ) {
        return;
      }

      if (writes.length > 0) {
        if (writes[0][0] === INTERRUPT) {
          // in `algo.ts` we append a bool to the task path to indicate
          // whether or not a call was present. If so, we don't emit the
          // the interrupt as it'll be emitted by the parent.
          if (task.path?.[0] === PUSH && task.path?.at(-1) === true) return;

          const interruptWrites = writes
            .filter((w) => w[0] === INTERRUPT)
            .flatMap((w) => w[1] as string[]);

          this._emit([
            ["updates", { [INTERRUPT]: interruptWrites }],
            ["values", { [INTERRUPT]: interruptWrites }],
          ]);
        } else if (writes[0][0] !== ERROR) {
          this._emit(
            gatherIteratorSync(
              prefixGenerator(
                mapOutputUpdates(this.outputKeys, [[task, writes]], cached),
                "updates"
              )
            )
          );
        }
      }
      if (!cached) {
        this._emit(
          gatherIteratorSync(
            prefixGenerator(
              mapDebugTaskResults([[task, writes]], this.streamKeys),
              "tasks"
            )
          )
        );
      }
    }
  }

  async _matchCachedWrites() {
    if (!this.cache) return [];

    const matched: {
      task: PregelExecutableTask<string, string>;
      result: unknown;
    }[] = [];

    const serializeKey = ([ns, key]: CacheFullKey) => {
      return `ns:${ns.join(",")}|key:${key}`;
    };

    const keys: CacheFullKey[] = [];
    const keyMap: Record<string, PregelExecutableTask<string, string>> = {};

    for (const task of Object.values(this.tasks)) {
      if (task.cache_key != null && !task.writes.length) {
        keys.push([task.cache_key.ns, task.cache_key.key]);
        keyMap[serializeKey([task.cache_key.ns, task.cache_key.key])] = task;
      }
    }

    if (keys.length === 0) return [];
    const cache = await this.cache.get(keys);

    for (const { key, value } of cache) {
      const task = keyMap[serializeKey(key)];
      if (task != null) {
        // update the task with the cached writes
        task.writes.push(...value);
        matched.push({ task, result: value });
      }
    }

    return matched;
  }

  /**
   * Execute a single iteration of the Pregel loop.
   * Returns true if more iterations are needed.
   * @param params
   */
  async tick(params: { inputKeys?: string | string[] }): Promise<boolean> {
    if (this.store && !this.store.isRunning) {
      await this.store?.start();
    }
    const { inputKeys = [] } = params;
    if (this.status !== "pending") {
      throw new Error(
        `Cannot tick when status is no longer "pending". Current status: "${this.status}"`
      );
    }
    if (![INPUT_DONE, INPUT_RESUMING].includes(this.input)) {
      await this._first(inputKeys);
    } else if (this.toInterrupt.length > 0) {
      this.status = "interrupt_before";
      throw new GraphInterrupt();
    } else if (
      Object.values(this.tasks).every((task) => task.writes.length > 0)
    ) {
      // finish superstep
      const writes = Object.values(this.tasks).flatMap((t) => t.writes);
      // All tasks have finished
      _applyWrites(
        this.checkpoint,
        this.channels,
        Object.values(this.tasks),
        this.checkpointerGetNextVersion,
        this.triggerToNodes
      );
      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(this.outputKeys, writes, this.channels),
          "values"
        )
      );
      this._emit(valuesOutput);
      // clear pending writes
      this.checkpointPendingWrites = [];
      await this._putCheckpoint({ source: "loop" });
      // after execution, check if we should interrupt
      if (
        shouldInterrupt(
          this.checkpoint,
          this.interruptAfter,
          Object.values(this.tasks)
        )
      ) {
        this.status = "interrupt_after";
        throw new GraphInterrupt();
      }

      // unset resuming flag
      if (this.config.configurable?.[CONFIG_KEY_RESUMING] !== undefined) {
        delete this.config.configurable?.[CONFIG_KEY_RESUMING];
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
      this.checkpointPendingWrites,
      this.nodes,
      this.channels,
      this.config,
      true,
      {
        step: this.step,
        checkpointer: this.checkpointer,
        isResuming: this.isResuming,
        manager: this.manager,
        store: this.store,
        stream: this.stream,
      }
    );
    this.tasks = nextTasks;

    // Produce debug output
    if (this.checkpointer) {
      this._emit(
        await gatherIterator(
          prefixGenerator(
            mapDebugCheckpoint(
              this.checkpointConfig,
              this.channels,
              this.streamKeys,
              this.checkpointMetadata,
              Object.values(this.tasks),
              this.checkpointPendingWrites,
              this.prevCheckpointConfig,
              this.outputKeys
            ),
            "checkpoints"
          )
        )
      );
    }

    if (Object.values(this.tasks).length === 0) {
      this.status = "done";
      return false;
    }
    // if there are pending writes from a previous loop, apply them
    if (this.skipDoneTasks && this.checkpointPendingWrites.length > 0) {
      for (const [tid, k, v] of this.checkpointPendingWrites) {
        if (k === ERROR || k === INTERRUPT || k === RESUME) {
          continue;
        }
        const task = Object.values(this.tasks).find((t) => t.id === tid);
        if (task) {
          task.writes.push([k, v]);
        }
      }
      for (const task of Object.values(this.tasks)) {
        if (task.writes.length > 0) {
          this._outputWrites(task.id, task.writes, true);
        }
      }
    }
    // if all tasks have finished, re-tick
    if (Object.values(this.tasks).every((task) => task.writes.length > 0)) {
      return this.tick({ inputKeys });
    }

    // Before execution, check if we should interrupt
    if (
      shouldInterrupt(
        this.checkpoint,
        this.interruptBefore,
        Object.values(this.tasks)
      )
    ) {
      this.status = "interrupt_before";
      throw new GraphInterrupt();
    }

    // Produce debug output
    const debugOutput = await gatherIterator(
      prefixGenerator(mapDebugTasks(Object.values(this.tasks)), "tasks")
    );
    this._emit(debugOutput);

    return true;
  }

  async finishAndHandleError(error?: Error) {
    // persist current checkpoint and writes
    if (
      this.durability === "exit" &&
      // if it's a top graph
      (!this.isNested ||
        // or a nested graph with error or interrupt
        typeof error !== "undefined" ||
        // or a nested graph with checkpointer: true
        this.checkpointNamespace.every(
          (part) => !part.includes(CHECKPOINT_NAMESPACE_END)
        ))
    ) {
      this._putCheckpoint(this.checkpointMetadata);
      this._flushPendingWrites();
    }

    const suppress = this._suppressInterrupt(error);
    if (suppress || error === undefined) {
      this.output = readChannels(this.channels, this.outputKeys);
    }
    if (suppress) {
      // emit one last "values" event, with pending writes applied
      if (
        this.tasks !== undefined &&
        this.checkpointPendingWrites.length > 0 &&
        Object.values(this.tasks).some((task) => task.writes.length > 0)
      ) {
        _applyWrites(
          this.checkpoint,
          this.channels,
          Object.values(this.tasks),
          this.checkpointerGetNextVersion,
          this.triggerToNodes
        );

        this._emit(
          gatherIteratorSync(
            prefixGenerator(
              mapOutputValues(
                this.outputKeys,
                Object.values(this.tasks).flatMap((t) => t.writes),
                this.channels
              ),
              "values"
            )
          )
        );
      }

      // Emit INTERRUPT event
      if (isGraphInterrupt(error) && !error.interrupts.length) {
        this._emit([
          ["updates", { [INTERRUPT]: [] }],
          ["values", { [INTERRUPT]: [] }],
        ]);
      }
    }
    return suppress;
  }

  async acceptPush(
    task: PregelExecutableTask<string, string>,
    writeIdx: number,
    call?: Call
  ): Promise<PregelExecutableTask<string, string> | void> {
    if (
      this.interruptAfter?.length > 0 &&
      shouldInterrupt(this.checkpoint, this.interruptAfter, [task])
    ) {
      this.toInterrupt.push(task);
      return;
    }

    const pushed = _prepareSingleTask(
      [PUSH, task.path ?? [], writeIdx, task.id, call] as CallTaskPath,
      this.checkpoint,
      this.checkpointPendingWrites,
      this.nodes,
      this.channels,
      task.config ?? {},
      true,
      {
        step: this.step,
        checkpointer: this.checkpointer,
        manager: this.manager,
        store: this.store,
        stream: this.stream,
      }
    );

    if (!pushed) return;
    if (
      this.interruptBefore?.length > 0 &&
      shouldInterrupt(this.checkpoint, this.interruptBefore, [pushed])
    ) {
      this.toInterrupt.push(pushed);
      return;
    }

    this._emit(
      gatherIteratorSync(prefixGenerator(mapDebugTasks([pushed]), "tasks"))
    );

    if (this.debug) printStepTasks(this.step, [pushed]);
    this.tasks[pushed.id] = pushed;
    if (this.skipDoneTasks) this._matchWrites({ [pushed.id]: pushed });

    const tasks = await this._matchCachedWrites();
    for (const { task } of tasks) {
      this._outputWrites(task.id, task.writes, true);
    }

    return pushed;
  }

  protected _suppressInterrupt(e?: Error): boolean {
    return isGraphInterrupt(e) && !this.isNested;
  }

  protected async _first(inputKeys: string | string[]) {
    /*
     * Resuming from previous checkpoint requires
     * - finding a previous checkpoint
     * - receiving null input (outer graph) or RESUMING flag (subgraph)
     */

    const { configurable } = this.config;

    // take resume value from parent
    const scratchpad = configurable?.[
      CONFIG_KEY_SCRATCHPAD
    ] as PregelScratchpad;

    if (scratchpad && scratchpad.nullResume !== undefined) {
      this.putWrites(NULL_TASK_ID, [[RESUME, scratchpad.nullResume]]);
    }

    // map command to writes
    if (isCommand(this.input)) {
      const hasResume = this.input.resume != null;

      if (
        this.input.resume != null &&
        typeof this.input.resume === "object" &&
        Object.keys(this.input.resume).every(isXXH3)
      ) {
        this.config.configurable ??= {};
        this.config.configurable[CONFIG_KEY_RESUME_MAP] = this.input.resume;
      }

      if (hasResume && this.checkpointer == null) {
        throw new Error("Cannot use Command(resume=...) without checkpointer");
      }

      const writes: { [key: string]: PendingWrite[] } = {};

      // group writes by task id
      for (const [tid, key, value] of mapCommand(
        this.input,
        this.checkpointPendingWrites
      )) {
        writes[tid] ??= [];
        writes[tid].push([key, value]);
      }
      if (Object.keys(writes).length === 0) {
        throw new EmptyInputError("Received empty Command input");
      }

      // save writes
      for (const [tid, ws] of Object.entries(writes)) {
        this.putWrites(tid, ws);
      }
    }

    // apply null writes
    const nullWrites = (this.checkpointPendingWrites ?? [])
      .filter((w) => w[0] === NULL_TASK_ID)
      .map((w) => w.slice(1)) as PendingWrite<string>[];
    if (nullWrites.length > 0) {
      _applyWrites(
        this.checkpoint,
        this.channels,
        [
          {
            name: INPUT,
            writes: nullWrites,
            triggers: [],
          },
        ],
        this.checkpointerGetNextVersion,
        this.triggerToNodes
      );
    }
    const isCommandUpdateOrGoto =
      isCommand(this.input) && nullWrites.length > 0;
    if (this.isResuming || isCommandUpdateOrGoto) {
      for (const channelName in this.channels) {
        if (!Object.prototype.hasOwnProperty.call(this.channels, channelName))
          continue;
        if (this.checkpoint.channel_versions[channelName] !== undefined) {
          const version = this.checkpoint.channel_versions[channelName];
          this.checkpoint.versions_seen[INTERRUPT] = {
            ...this.checkpoint.versions_seen[INTERRUPT],
            [channelName]: version,
          };
        }
      }
      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(this.outputKeys, true, this.channels),
          "values"
        )
      );
      this._emit(valuesOutput);
    }
    if (this.isResuming) {
      this.input = INPUT_RESUMING;
    } else if (isCommandUpdateOrGoto) {
      // we need to create a new checkpoint for Command(update=...) or Command(goto=...)
      // in case the result of Command(goto=...) is an interrupt.
      // If not done, the checkpoint containing the interrupt will be lost.
      await this._putCheckpoint({ source: "input" });
      this.input = INPUT_DONE;
    } else {
      // map inputs to channel updates
      const inputWrites = await gatherIterator(mapInput(inputKeys, this.input));
      if (inputWrites.length > 0) {
        const discardTasks = _prepareNextTasks(
          this.checkpoint,
          this.checkpointPendingWrites,
          this.nodes,
          this.channels,
          this.config,
          true,
          { step: this.step }
        );
        _applyWrites(
          this.checkpoint,
          this.channels,
          (Object.values(discardTasks) as WritesProtocol[]).concat([
            {
              name: INPUT,
              writes: inputWrites as PendingWrite[],
              triggers: [],
            },
          ]),
          this.checkpointerGetNextVersion,
          this.triggerToNodes
        );
        // save input checkpoint
        await this._putCheckpoint({ source: "input" });

        this.input = INPUT_DONE;
      } else if (!(CONFIG_KEY_RESUMING in (this.config.configurable ?? {}))) {
        throw new EmptyInputError(
          `Received no input writes for ${JSON.stringify(inputKeys, null, 2)}`
        );
      } else {
        // done with input
        this.input = INPUT_DONE;
      }
    }
    if (!this.isNested) {
      this.config = patchConfigurable(this.config, {
        [CONFIG_KEY_RESUMING]: this.isResuming,
      });
    }
  }

  protected _emit(values: [StreamMode, unknown][]) {
    for (const [mode, payload] of values) {
      if (this.stream.modes.has(mode)) {
        this.stream.push([this.checkpointNamespace, mode, payload]);
      }

      // debug mode is a "checkpoints" or "tasks" wrapped in an object
      // TODO: consider deprecating this in 1.x
      if (
        (mode === "checkpoints" || mode === "tasks") &&
        this.stream.modes.has("debug")
      ) {
        const step = mode === "checkpoints" ? this.step - 1 : this.step;
        const timestamp = new Date().toISOString();
        const type = (() => {
          if (mode === "checkpoints") {
            return "checkpoint";
          } else if (
            typeof payload === "object" &&
            payload != null &&
            "result" in payload
          ) {
            return "task_result";
          } else {
            return "task";
          }
        })();

        this.stream.push([
          this.checkpointNamespace,
          "debug",
          { step, type, timestamp, payload },
        ]);
      }
    }
  }

  protected _putCheckpoint(
    inputMetadata: Omit<CheckpointMetadata, "step" | "parents">
  ) {
    const exiting = this.checkpointMetadata === inputMetadata;

    const doCheckpoint =
      this.checkpointer != null && (this.durability !== "exit" || exiting);

    const storeCheckpoint = (checkpoint: Checkpoint) => {
      // store the previous checkpoint config for debug events
      this.prevCheckpointConfig = this.checkpointConfig?.configurable
        ?.checkpoint_id
        ? this.checkpointConfig
        : undefined;

      // child graphs keep at most one checkpoint per parent checkpoint
      // this is achieved by writing child checkpoints as progress is made
      // (so that error recovery / resuming from interrupt don't lose work)
      // but doing so always with an id equal to that of the parent checkpoint
      this.checkpointConfig = patchConfigurable(this.checkpointConfig, {
        [CONFIG_KEY_CHECKPOINT_NS]:
          this.config.configurable?.checkpoint_ns ?? "",
      });

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
        checkpoint: copyCheckpoint(checkpoint),
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
    };

    if (!exiting) {
      this.checkpointMetadata = {
        ...inputMetadata,
        step: this.step,
        parents: this.config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP] ?? {},
      };
    }

    // create new checkpoint
    this.checkpoint = createCheckpoint(
      this.checkpoint,
      doCheckpoint ? this.channels : undefined,
      this.step,
      exiting ? { id: this.checkpoint.id } : undefined
    );

    // Bail if no checkpointer
    if (doCheckpoint) storeCheckpoint(this.checkpoint);

    if (!exiting) {
      // increment step
      this.step += 1;
    }
  }

  protected _flushPendingWrites() {
    if (this.checkpointer == null) return;
    if (this.checkpointPendingWrites.length === 0) return;

    // patch config
    const config = patchConfigurable(this.checkpointConfig, {
      [CONFIG_KEY_CHECKPOINT_NS]: this.config.configurable?.checkpoint_ns ?? "",
      [CONFIG_KEY_CHECKPOINT_ID]: this.checkpoint.id,
    });

    // group writes by task id
    const byTask: Record<string, PendingWrite<string>[]> = {};
    for (const [tid, key, value] of this.checkpointPendingWrites) {
      byTask[tid] ??= [];
      byTask[tid].push([key, value]);
    }

    // submit writes to checkpointer
    for (const [tid, ws] of Object.entries(byTask)) {
      this.checkpointerPromises.push(
        this.checkpointer.putWrites(config, ws, tid)
      );
    }
  }

  protected _matchWrites(
    tasks: Record<string, PregelExecutableTask<string, string>>
  ) {
    for (const [tid, k, v] of this.checkpointPendingWrites) {
      if (k === ERROR || k === INTERRUPT || k === RESUME) {
        continue;
      }
      const task = Object.values(tasks).find((t) => t.id === tid);
      if (task) {
        task.writes.push([k, v]);
      }
    }
    for (const task of Object.values(tasks)) {
      if (task.writes.length > 0) {
        this._outputWrites(task.id, task.writes, true);
      }
    }
  }
}
