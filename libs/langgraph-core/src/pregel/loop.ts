import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import { BaseMessage } from "@langchain/core/messages";
import { v4 as uuidv4 } from "@langchain/core/utils/uuid";
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
  channelsFromCheckpoint,
  deltaChannelsToSnapshot,
  exitDeltaTaskId,
  isDeltaChannel,
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
  _isSend,
  _isOverwriteValue,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Command,
  CONFIG_KEY_CHECKPOINT_MAP,
  CONFIG_KEY_READ,
  CONFIG_KEY_RESUMING,
  CONFIG_KEY_STREAM,
  ERROR,
  ERROR_SOURCE_NODE,
  INPUT,
  INTERRUPT,
  NULL_TASK_ID,
  RESUME,
  TAG_HIDDEN,
  TASKS,
  PUSH,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_CHECKPOINT_NS,
  CHECKPOINT_NAMESPACE_END,
  CONFIG_KEY_CHECKPOINT_ID,
  CONFIG_KEY_RESUME_MAP,
  CONFIG_KEY_REPLAY_STATE,
  START,
} from "../constants.js";
import { ReplayState } from "./replay.js";
import {
  _applyWrites,
  _prepareNextTasks,
  _prepareNodeErrorHandlerTask,
  _prepareSingleTask,
  increment,
  shouldInterrupt,
  sanitizeUntrackedValuesInSend,
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
import type { RunControl } from "./runtime.js";
import {
  createDuplexStream,
  IterableReadableWritableStream,
  StreamChunkMeta,
} from "./stream.js";
import { isXXH3 } from "../hash.js";

const INPUT_DONE = Symbol.for("INPUT_DONE");
const INPUT_RESUMING = Symbol.for("INPUT_RESUMING");
const DEFAULT_LOOP_LIMIT = 25;

/**
 * Recursively assign a stable UUID to any {@link BaseMessage} (in a value, an
 * array, or an object's values) that is missing an `id`. Used so DeltaChannel
 * writes — replayed on every read — reconstruct identical message identities.
 */
function ensureMessageIds(value: unknown): void {
  if (value == null || typeof value !== "object") return;
  if (BaseMessage.isInstance(value)) {
    const msg = value as BaseMessage;
    if (msg.id == null) {
      msg.id = uuidv4();
      if (msg.lc_kwargs != null) msg.lc_kwargs.id = msg.id;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) ensureMessageIds(item);
    return;
  }
}

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
  resumeAtHead: boolean;
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
  hasPersistedParent?: boolean;
};

/**
 * Split a serialized checkpoint namespace into its path segments.
 *
 * Checkpoint namespaces are stored as a single string whose nested levels are
 * joined by {@link CHECKPOINT_NAMESPACE_SEPARATOR} (e.g. `"parent|child"`).
 * The root namespace — represented as `undefined` or the empty string — maps
 * to an empty array.
 *
 * @param ns - The serialized checkpoint namespace, or `undefined`.
 * @returns The namespace as an array of path segments (`[]` for the root).
 */
function checkpointNamespaceFromNs(ns: string | undefined): string[] {
  if (ns === undefined || ns === "") return [];
  return ns.split(CHECKPOINT_NAMESPACE_SEPARATOR);
}

/**
 * Find the most deeply nested namespace recorded in a checkpoint map.
 *
 * The checkpoint map ({@link CONFIG_KEY_CHECKPOINT_MAP}) associates every
 * namespace seen on a thread with its checkpoint id. Because nested namespaces
 * are built by appending segments to their parent, a deeper namespace always
 * yields a longer key — so the longest non-empty key is the deepest one.
 *
 * Used by the loop's `#interruptStreamNamespace()` during subgraph
 * time-travel: interrupt events must be emitted against the active (deepest)
 * subgraph namespace rather than the root graph.
 *
 * @param map - The checkpoint map (namespace -> checkpoint id), or `undefined`.
 * @returns The deepest namespace as path segments, or `[]` when the map is
 *   absent, empty, or only contains the root namespace.
 */
function deepestCheckpointMapNamespace(
  map: Record<string, string> | undefined
): string[] {
  if (!map) return [];
  let deepest = "";
  for (const key of Object.keys(map)) {
    if (key !== "" && key.length > deepest.length) {
      deepest = key;
    }
  }
  return checkpointNamespaceFromNs(deepest);
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

  /**
   * Exit-mode accumulator of DeltaChannel writes across the whole run, as
   * `[step, taskId, channel, value]`. `undefined` outside "exit" durability.
   */
  protected _exitDeltaWrites: [number, string, string, unknown][] | undefined;

  /**
   * DeltaChannels that saw an Overwrite since the last checkpoint. These
   * channels are force-snapshotted at the next checkpoint so reconstruction
   * starts from the post-overwrite value and never has to replay across the
   * reset (the live `update` discards every sibling write in the overwriting
   * super-step). Cleared once the channel snapshots.
   */
  protected _deltaChannelsWithOverwrite: Set<string> = new Set();

  /** Whether a real checkpoint was loaded from the saver at initialization. */
  protected _hasPersistedParent = false;

  /** The checkpointConfig as captured at initialization (anchor for exit writes). */
  protected _initialCheckpointConfig: RunnableConfig | undefined;

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

  protected updatedChannels: Set<string> | undefined;

  status:
    | "pending"
    | "done"
    | "interrupt_before"
    | "interrupt_after"
    | "out_of_steps"
    | "draining" = "pending";

  /**
   * Run-scoped control surface for cooperative draining. Populated from the
   * run config. When `control.drainRequested` is true, the loop stops at the
   * next superstep boundary instead of dispatching more tasks.
   */
  control?: RunControl;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Record<string, PregelExecutableTask<any, any>> = {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: IterableReadableWritableStream;

  checkpointerPromises: Set<Promise<unknown>> = new Set();

  isNested: boolean;

  /** True when an explicit checkpoint_id targets the latest saved checkpoint. */
  protected resumeAtHead: boolean;

  protected _checkpointerChainedPromise: Promise<unknown> = Promise.resolve();

  /**
   * Track a checkpointer promise, removing it from the set on success.
   * Failed promises are kept so that Promise.all() in the finally block
   * of _streamIterator can surface the error.
   *
   * @internal
   */
  protected _trackCheckpointerPromise(promise: Promise<unknown>) {
    const tracked = promise.then(
      (value) => {
        this.checkpointerPromises.delete(tracked);
        return value;
      },
      (error) => {
        // Keep failed promises in the set so errors surface via Promise.all()
        throw error;
      }
    );
    this.checkpointerPromises.add(tracked);
  }

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

  get isReplaying(): boolean {
    return !this.skipDoneTasks;
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
    this.resumeAtHead = params.resumeAtHead;
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
    this.control = this.config.control;
    // Exit-mode delta-channel accumulator: in "exit" durability, per-step
    // writes are not persisted incrementally, so DeltaChannel writes would be
    // lost. Accumulate them across the run and persist (anchored to a parent
    // or stub) at exit. `undefined` outside exit mode disables capture.
    this._exitDeltaWrites =
      this.durability === "exit" && this.checkpointer != null ? [] : undefined;
    this._hasPersistedParent = params.hasPersistedParent ?? false;
    this._initialCheckpointConfig = params.checkpointConfig;
    this.checkpointIdSaved = params.checkpoint.id;
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

    const requestedCheckpointId = config.configurable?.checkpoint_id as
      | string
      | undefined;

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
      config.configurable?.checkpoint_id === undefined &&
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
    const checkpointNamespace = checkpointNamespaceFromNs(
      config.configurable?.checkpoint_ns
    );

    let saved: CheckpointTuple | undefined;
    if (!params.checkpointer) {
      saved = undefined;
    } else if (checkpointConfig.configurable?.[CONFIG_KEY_CHECKPOINT_ID]) {
      saved = await params.checkpointer.getTuple(checkpointConfig);
    } else if (config.configurable?.[CONFIG_KEY_REPLAY_STATE]) {
      const replayState = config.configurable[
        CONFIG_KEY_REPLAY_STATE
      ] as ReplayState;
      saved = await replayState.getCheckpoint(
        config.configurable?.[CONFIG_KEY_CHECKPOINT_NS] ?? "",
        params.checkpointer,
        checkpointConfig
      );
      if (config.configurable) {
        delete config.configurable[CONFIG_KEY_RESUMING];
      }
    } else {
      saved = await params.checkpointer.getTuple(checkpointConfig);
    }
    const hasPersistedParent = saved !== undefined;
    if (!saved) {
      saved = {
        config,
        checkpoint: emptyCheckpoint(),
        metadata: { source: "input", step: -2, parents: {} },
        pendingWrites: [],
      };
    }
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
    let checkpointPendingWrites = saved.pendingWrites ?? [];
    const currentCheckpointNamespace = config.configurable?.checkpoint_ns;
    const checkpointMap = config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP];
    const isDirectSubgraphTimeTravel =
      typeof currentCheckpointNamespace === "string" &&
      currentCheckpointNamespace !== "" &&
      typeof checkpointMap === "object" &&
      checkpointMap !== null &&
      currentCheckpointNamespace in checkpointMap;

    if (isDirectSubgraphTimeTravel && checkpointPendingWrites.length > 0) {
      // Direct subgraph time-travel should re-fire interrupts instead of
      // consuming stale resume values that were written during the original run.
      checkpointPendingWrites = checkpointPendingWrites.filter(
        ([, channel]) => channel !== RESUME
      );
    }

    let resumeAtHead = false;
    const threadId = checkpointConfig.configurable?.thread_id;
    const checkpointNs = checkpointConfig.configurable?.checkpoint_ns ?? "";
    if (
      params.checkpointer &&
      requestedCheckpointId &&
      typeof threadId === "string"
    ) {
      const latest = await params.checkpointer.getTuple({
        configurable: { thread_id: threadId, checkpoint_ns: checkpointNs },
      });
      resumeAtHead =
        latest?.config.configurable?.checkpoint_id === requestedCheckpointId &&
        checkpointMetadata.source !== "update" &&
        checkpointMetadata.source !== "fork";
    }

    const channels = await channelsFromCheckpoint(
      params.channelSpecs,
      checkpoint,
      {
        saver: params.checkpointer,
        config: checkpointConfig,
      }
    );

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
      resumeAtHead,
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
      hasPersistedParent,
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
    this._trackCheckpointerPromise(this._checkpointerChainedPromise);
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

    // Check if any channels are UntrackedValue (manual loop for perf)
    let hasUntrackedChannels = false;
    for (const key in this.channels) {
      if (Object.prototype.hasOwnProperty.call(this.channels, key)) {
        const channel = this.channels[key];
        if (channel.lc_graph_name === "UntrackedValue") {
          hasUntrackedChannels = true;
          break;
        }
      }
    }

    // Sanitize writes for checkpointing: remove UntrackedValue writes and sanitize Send packets
    let writesToSave = writesCopy;
    if (hasUntrackedChannels) {
      writesToSave = writesCopy
        .filter(([c]) => {
          // Don't persist UntrackedValue channel writes
          const channel = this.channels[c];
          return !channel || channel.lc_graph_name !== "UntrackedValue";
        })
        .map(([c, v]) => {
          // Sanitize UntrackedValues nested within Send packets
          if (c === TASKS && _isSend(v)) {
            return [c, sanitizeUntrackedValuesInSend(v, this.channels)] as [
              string,
              unknown,
            ];
          }
          return [c, v] as [string, unknown];
        });
    }

    // remove existing writes for this task
    this.checkpointPendingWrites = this.checkpointPendingWrites.filter(
      (w) => w[0] !== taskId
    );

    // save writes
    for (const [c, v] of writesToSave) {
      this.checkpointPendingWrites.push([taskId, c, v]);
    }

    // Assign stable IDs to any id-less BaseMessages in DeltaChannel writes
    // before they are serialised. DeltaChannel state is reconstructed by
    // replaying these stored writes, so without stable IDs every getState()
    // replay would mint a fresh UUID and dedup/RemoveMessage would break.
    for (const [c, v] of writesToSave) {
      const channel = this.channels[c];
      if (channel != null && isDeltaChannel(channel)) {
        ensureMessageIds(v);
      }
    }

    const config = patchConfigurable(this.checkpointConfig, {
      [CONFIG_KEY_CHECKPOINT_NS]: this.config.configurable?.checkpoint_ns ?? "",
      [CONFIG_KEY_CHECKPOINT_ID]: this.checkpoint.id,
    });

    if (this.durability !== "exit" && this.checkpointer != null) {
      this._trackCheckpointerPromise(
        // Use sanitized writes for checkpointer
        this.checkpointer.putWrites(config, writesToSave, taskId)
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
          if (
            task.path?.[0] === PUSH &&
            task.path?.[task.path.length - 1] === true
          )
            return;

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
   * @param params - The input keys to use for the tick.
   * @returns True if more iterations are needed, false otherwise.
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
      const finishTaskList = Object.values(this.tasks);
      // finish superstep
      const writes = finishTaskList.flatMap((t) => t.writes);
      // All tasks have finished
      this.updatedChannels = _applyWrites(
        this.checkpoint,
        this.channels,
        finishTaskList,
        this.checkpointerGetNextVersion,
        this.triggerToNodes
      );
      // Track DeltaChannels that saw an Overwrite this super-step. They must
      // snapshot at the next checkpoint so sparse replay starts from the
      // post-overwrite value (live `update` already discarded the siblings).
      for (const [ch, v] of writes) {
        const channel = this.channels[ch];
        if (
          channel != null &&
          isDeltaChannel(channel) &&
          _isOverwriteValue(v)
        ) {
          this._deltaChannelsWithOverwrite.add(ch);
        }
      }
      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(this.outputKeys, writes, this.channels),
          "values"
        )
      );
      // capture delta-channel writes for the exit-mode accumulator before
      // clearing (in "exit" durability they are not persisted incrementally)
      if (this._exitDeltaWrites !== undefined) {
        for (const [tid, ch, v] of this.checkpointPendingWrites) {
          const channel = this.channels[ch];
          if (channel != null && isDeltaChannel(channel)) {
            this._exitDeltaWrites.push([this.step, tid, ch, v]);
          }
        }
      }
      // clear pending writes
      this.checkpointPendingWrites = [];
      // persist the new checkpoint BEFORE emitting values, so the
      // attached `checkpoint` envelope on the values event points at
      // the fork target that captures this superstep's final state.
      await this._putCheckpoint({ source: "loop" });
      this._emitValuesWithCheckpointMeta(valuesOutput);
      // after execution, check if we should interrupt
      if (
        shouldInterrupt(this.checkpoint, this.interruptAfter, finishTaskList)
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
        triggerToNodes: this.triggerToNodes,
        updatedChannels: this.updatedChannels,
      }
    );
    this.tasks = nextTasks;
    let taskList = Object.values(this.tasks);

    // Full-state checkpoint snapshots are expensive; skip unless a consumer
    // subscribed to "checkpoints" or the legacy "debug" wrapper mode.
    if (
      this.checkpointer &&
      (this.stream.modes.has("checkpoints") || this.stream.modes.has("debug"))
    ) {
      this._emit(
        await gatherIterator(
          prefixGenerator(
            mapDebugCheckpoint(
              this.checkpointConfig,
              this.channels,
              this.streamKeys,
              this.checkpointMetadata,
              taskList,
              this.checkpointPendingWrites,
              this.prevCheckpointConfig,
              this.outputKeys
            ),
            "checkpoints"
          )
        )
      );
    }

    if (taskList.length === 0) {
      this.status = "done";
      return false;
    }
    // Cooperative drain: the previous superstep's writes have been applied
    // and checkpointed above, and the next tasks have been prepared. If a
    // drain was requested and tasks remain, stop here (without dispatching
    // them) so the run can be resumed later from the saved checkpoint.
    if (this.control != null && this.control.drainRequested) {
      this.status = "draining";
      return false;
    }
    // if there are pending writes from a previous loop, apply them
    if (this.skipDoneTasks && this.checkpointPendingWrites.length > 0) {
      for (const [tid, k, v] of this.checkpointPendingWrites) {
        if (
          k === ERROR ||
          k === ERROR_SOURCE_NODE ||
          k === INTERRUPT ||
          k === RESUME
        ) {
          continue;
        }
        const task = taskList.find((t) => t.id === tid);
        if (task) {
          task.writes.push([k, v]);
        }
      }
      // On resume, re-schedule error handlers for nodes that failed in a prior
      // run (recorded via ERROR_SOURCE_NODE) before they completed handling.
      this._resumeErrorHandlersIfApplicable();
      // Re-scheduling can add handler tasks to `this.tasks`, so refresh the
      // cached task list before emitting writes and the downstream re-tick /
      // interrupt / debug checks see the newly scheduled handlers.
      taskList = Object.values(this.tasks);
      for (const task of taskList) {
        if (task.writes.length > 0) {
          this._outputWrites(task.id, task.writes, true);
        }
      }
    }
    // if all tasks have finished, re-tick
    if (taskList.every((task) => task.writes.length > 0)) {
      return this.tick({ inputKeys });
    }

    // Before execution, check if we should interrupt
    if (shouldInterrupt(this.checkpoint, this.interruptBefore, taskList)) {
      this.status = "interrupt_before";
      throw new GraphInterrupt();
    }

    if (this.stream.modes.has("tasks") || this.stream.modes.has("debug")) {
      const debugOutput = await gatherIterator(
        prefixGenerator(mapDebugTasks(taskList), "tasks")
      );
      this._emit(debugOutput);
    }

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
      await this._putExitDeltaWrites();
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
        this.updatedChannels = _applyWrites(
          this.checkpoint,
          this.channels,
          Object.values(this.tasks),
          this.checkpointerGetNextVersion,
          this.triggerToNodes
        );

        this._emitValuesWithCheckpointMeta(
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

      // Emit INTERRUPT event (not a state snapshot — no checkpoint envelope)
      if (isGraphInterrupt(error) && !error.interrupts.length) {
        this._emit(
          [
            ["updates", { [INTERRUPT]: [] }],
            ["values", { [INTERRUPT]: [] }],
          ],
          this.#interruptStreamNamespace()
        );
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

    if (this.stream.modes.has("tasks") || this.stream.modes.has("debug")) {
      this._emit(
        gatherIteratorSync(prefixGenerator(mapDebugTasks([pushed]), "tasks"))
      );
    }

    if (this.debug) printStepTasks(this.step, [pushed]);
    this.tasks[pushed.id] = pushed;
    if (this.skipDoneTasks) this._matchWrites({ [pushed.id]: pushed });

    const tasks = await this._matchCachedWrites();
    for (const { task } of tasks) {
      this._outputWrites(task.id, task.writes, true);
    }

    return pushed;
  }

  /**
   * Returns the name of the error handler node registered for `nodeName`, or
   * `undefined` if none is configured.
   */
  getErrorHandlerNode(nodeName: string): string | undefined {
    return this.nodes[nodeName]?.errorHandlerNode;
  }

  /**
   * Whether `nodeName` is itself an auto-generated error handler node.
   */
  isErrorHandlerNode(nodeName: string): boolean {
    return this.nodes[nodeName]?.isErrorHandler === true;
  }

  /**
   * Schedule a node-level error handler task for a task that failed after its
   * retry policy was exhausted. Prepares the handler task (injecting a
   * {@link NodeError}), registers it so the runner executes it within the
   * current step, and returns it (or `undefined` if no handler applies).
   *
   * The failure provenance (`ERROR` + `ERROR_SOURCE_NODE`) is checkpointed by
   * the runner via {@link PregelLoop#putWrites} so handlers observe the same
   * context after a resume.
   */
  scheduleErrorHandler(
    failedTask: PregelExecutableTask<string, string>,
    error: Error
  ): PregelExecutableTask<string, string> | undefined {
    const handlerNode = this.getErrorHandlerNode(String(failedTask.name));
    if (!handlerNode) return undefined;

    const handlerTask = _prepareNodeErrorHandlerTask(
      failedTask,
      handlerNode,
      error,
      this.checkpoint,
      this.checkpointPendingWrites,
      this.nodes,
      this.channels,
      failedTask.config ?? this.config,
      {
        step: this.step,
        checkpointer: this.checkpointer,
        manager: this.manager,
        store: this.store,
        stream: this.stream,
      }
    ) as PregelExecutableTask<string, string> | undefined;

    if (handlerTask === undefined) return undefined;

    this.tasks[handlerTask.id] = handlerTask;

    this._emit(
      gatherIteratorSync(prefixGenerator(mapDebugTasks([handlerTask]), "tasks"))
    );
    if (this.debug) printStepTasks(this.step, [handlerTask]);

    return handlerTask;
  }

  /**
   * On resume, re-schedule error handlers for tasks that failed in a prior run
   * but had not finished being handled. Scans pending writes for
   * `ERROR_SOURCE_NODE` markers (paired with `ERROR`), marks the originating
   * task as done (so the runner won't re-run it), and prepares a fresh handler
   * task so the runner picks it up.
   */
  protected _resumeErrorHandlersIfApplicable() {
    // Collect failed task ids with both ERROR_SOURCE_NODE and ERROR writes.
    const failed = new Map<string, Error>();
    for (const [tid, chan] of this.checkpointPendingWrites) {
      if (chan !== ERROR_SOURCE_NODE) continue;
      const errorWrite = this.checkpointPendingWrites.find(
        ([t, c]) => t === tid && c === ERROR
      );
      if (errorWrite === undefined) continue;
      const value = errorWrite[2] as { message?: string; name?: string };
      const error = new Error(value?.message ?? String(value));
      if (value?.name) error.name = value.name;
      failed.set(tid, error);
    }

    for (const [tid, error] of failed) {
      const task = this.tasks[tid];
      if (task === undefined) continue;
      const handlerNode = this.getErrorHandlerNode(String(task.name));
      if (!handlerNode) continue;
      // Non-empty writes => runner's `writes.length === 0` filter skips it.
      if (task.writes.length === 0) {
        task.writes.push([ERROR, { message: error.message, name: error.name }]);
      }
      this.scheduleErrorHandler(task, error);
    }
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
    const inputIsCommand = isCommand(this.input);
    const isCommandUpdateOrGoto = inputIsCommand && nullWrites.length > 0;

    const isTimeTraveling =
      this.isReplaying &&
      // Time-travel to a subgraph checkpoint: the parent sets RESUMING=True
      // (it can't distinguish time-travel from resume), so we check if this
      // subgraph's own ns is in checkpoint_map.
      ((this.isNested &&
        configurable?.[CONFIG_KEY_CHECKPOINT_NS] !== undefined &&
        configurable?.[CONFIG_KEY_CHECKPOINT_NS] !== "" &&
        configurable?.[CONFIG_KEY_CHECKPOINT_MAP] !== undefined &&
        configurable[CONFIG_KEY_CHECKPOINT_NS] in
          configurable[CONFIG_KEY_CHECKPOINT_MAP]) ||
        !(
          (inputIsCommand && (this.input as Command).resume != null) ||
          configurable?.[CONFIG_KEY_RESUMING] === true ||
          this.resumeAtHead
        ));

    if (isTimeTraveling) {
      this.checkpointPendingWrites = this.checkpointPendingWrites.filter(
        (w) => w[1] !== RESUME
      );
    }

    const cachedIsResuming = this.isResuming;
    if (cachedIsResuming || isCommandUpdateOrGoto) {
      // One spread (O(N)) instead of O(N²) per-channel spreads. Must be a
      // new object — copyCheckpoint shallow-copies versions_seen.
      const interruptSeen: Record<string, string | number> = {
        ...this.checkpoint.versions_seen[INTERRUPT],
      };
      for (const channelName in this.channels) {
        if (!Object.prototype.hasOwnProperty.call(this.channels, channelName))
          continue;
        if (this.checkpoint.channel_versions[channelName] !== undefined) {
          interruptSeen[channelName] =
            this.checkpoint.channel_versions[channelName];
        }
      }
      this.checkpoint.versions_seen[INTERRUPT] = interruptSeen;

      if (
        isTimeTraveling &&
        this.checkpointMetadata.source !== "update" &&
        this.checkpointMetadata.source !== "fork"
      ) {
        this.checkpointPendingWrites = this.checkpointPendingWrites.filter(
          (w) => w[1] !== INTERRUPT
        );
        await this._putCheckpoint({ source: "fork" });
      }

      // produce values output
      const valuesOutput = await gatherIterator(
        prefixGenerator(
          mapOutputValues(this.outputKeys, true, this.channels),
          "values"
        )
      );
      // Preserve the original `isResuming`-first priority: when both
      // `isResuming` and `isCommandUpdateOrGoto` are true (resuming from
      // an interrupt with a Command update/goto), the resume path wins
      // and no new input checkpoint is created here.
      if (cachedIsResuming) {
        this.input = INPUT_RESUMING;
      } else if (isCommandUpdateOrGoto) {
        // Persist the input checkpoint BEFORE emitting values so the
        // attached `checkpoint` envelope points at the just-created
        // fork target. We need a new checkpoint for Command(update=...)
        // or Command(goto=...) in case the result of Command(goto=...)
        // is an interrupt. If not done, the checkpoint containing the
        // interrupt will be lost.
        await this._putCheckpoint({ source: "input" });
        this.input = INPUT_DONE;
      }
      // Emit after any checkpoint persistence so the `checkpoint` envelope
      // on the values event points at the fork target for the emitted state.
      this._emitValuesWithCheckpointMeta(valuesOutput);
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
        this.updatedChannels = _applyWrites(
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
        // Input writes go through `_applyWrites` directly (above) — they never
        // enter `checkpointPendingWrites`, so the after-tick capture site does
        // not see them.
        const deltaInput = (inputWrites as PendingWrite[]).filter(([c]) => {
          const channel = this.channels[c];
          return channel != null && isDeltaChannel(channel);
        });
        // An Overwrite supplied as input must also force a snapshot.
        for (const [c, v] of deltaInput) {
          if (_isOverwriteValue(v)) this._deltaChannelsWithOverwrite.add(c);
        }
        if (deltaInput.length > 0) {
          if (this._exitDeltaWrites !== undefined) {
            // Exit mode: capture so the accumulator includes input deltas.
            for (const [c, v] of deltaInput) {
              this._exitDeltaWrites.push([this.step, NULL_TASK_ID, c, v]);
            }
          } else if (this.checkpointer != null) {
            // Non-exit: persist so sub-frequency inputs are recoverable via the
            // ancestor walk (StateGraph routes inputs through a START node whose
            // writes are persisted; this covers raw Pregel delta input channels).
            this.putWrites(NULL_TASK_ID, deltaInput);
          }
        }
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
      let replayState: ReplayState | undefined;
      // Only pass ReplayState during time-travel, not when resuming from the
      // current head with an explicit checkpoint_id (see Python _loop._first).
      if (isTimeTraveling) {
        let replayCheckpointId = this.checkpoint.id;
        if (
          (this.checkpointMetadata.source === "update" ||
            this.checkpointMetadata.source === "fork") &&
          this.prevCheckpointConfig
        ) {
          replayCheckpointId =
            this.prevCheckpointConfig.configurable?.[
              CONFIG_KEY_CHECKPOINT_ID
            ] ?? replayCheckpointId;
        }
        replayState = new ReplayState(replayCheckpointId);
      }
      this.config = patchConfigurable(this.config, {
        [CONFIG_KEY_RESUMING]: this.isResuming,
        [CONFIG_KEY_REPLAY_STATE]: replayState,
      });
    }
  }

  #interruptStreamNamespace(): string[] {
    const ns = this.checkpointNamespace;
    const isRootNamespace =
      ns.length === 0 || (ns.length === 1 && ns[0] === "");
    if (
      !isRootNamespace ||
      this.config.configurable?.[CONFIG_KEY_STREAM] === undefined
    ) {
      return ns;
    }
    const deepest = deepestCheckpointMapNamespace(
      this.config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP] as
        | Record<string, string>
        | undefined
    );
    return deepest.length > 0 ? deepest : ns;
  }

  protected _emit(
    values: Array<[StreamMode, unknown]>,
    namespace: string[] = this.checkpointNamespace
  ) {
    for (const [mode, payload] of values) {
      if (this.stream.modes.has(mode)) {
        this.stream.push([namespace, mode, payload]);
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
          namespace,
          "debug",
          { step, type, timestamp, payload },
        ]);
      }
    }
  }

  /**
   * Build a {@link StreamChunkMeta} describing the currently active checkpoint.
   * Emitted as a separate ``[namespace, "checkpoints", envelope]`` chunk before
   * the paired ``values`` chunk. Returns `undefined` if no checkpoint metadata
   * is available yet.
   */
  protected _currentCheckpointMeta(): StreamChunkMeta | undefined {
    if (!this.checkpointMetadata || !this.checkpoint?.id) return undefined;
    const parent_id = this.prevCheckpointConfig?.configurable?.checkpoint_id as
      | string
      | undefined;
    return {
      checkpoint: {
        id: this.checkpoint.id,
        ...(parent_id ? { parent_id } : {}),
        step: this.checkpointMetadata.step,
        source: this.checkpointMetadata.source,
      },
    };
  }

  /**
   * Emit stream entries. When checkpoint meta is available, push a lightweight
   * ``[namespace, "checkpoints", envelope]`` chunk before each ``values`` chunk.
   */
  protected _emitValuesWithCheckpointMeta(
    entries: [StreamMode, unknown][]
  ): void {
    const meta = this._currentCheckpointMeta();
    for (const [mode, payload] of entries) {
      if (
        mode === "values" &&
        meta?.checkpoint != null &&
        !this.stream.modes.has("checkpoints")
      ) {
        this.stream.push([
          this.checkpointNamespace,
          "checkpoints",
          meta.checkpoint,
        ]);
      }
      if (this.stream.modes.has(mode)) {
        this.stream.push([this.checkpointNamespace, mode, payload]);
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

    // Per-delta-channel counter bookkeeping. Each delta channel tracks a
    // [updates, supersteps] pair: `updates` increments only when the channel
    // is written this step; `supersteps` increments every superstep. The exit
    // call must NOT bump again (the last intermediate call already counted the
    // final superstep) or it would double-count.
    let newCounters: Record<string, [number, number]>;
    if (!exiting) {
      const prevCounters =
        this.checkpointMetadata.counters_since_delta_snapshot ?? {};
      newCounters = {};
      const updated = this.updatedChannels ?? new Set<string>();
      for (const chName in this.channels) {
        if (!Object.prototype.hasOwnProperty.call(this.channels, chName))
          continue;
        if (!isDeltaChannel(this.channels[chName])) continue;
        const [u, s] = prevCounters[chName] ?? [0, 0];
        newCounters[chName] = [updated.has(chName) ? u + 1 : u, s + 1];
      }
      this.checkpointMetadata = {
        ...inputMetadata,
        step: this.step,
        parents: this.config.configurable?.[CONFIG_KEY_CHECKPOINT_MAP] ?? {},
      };
    } else {
      newCounters = {
        ...(this.checkpointMetadata.counters_since_delta_snapshot ?? {}),
      };
    }

    const channelsToSnapshot = doCheckpoint
      ? deltaChannelsToSnapshot(this.channels, newCounters)
      : new Set<string>();
    // Force a snapshot for any delta channel that saw an Overwrite since the
    // last checkpoint, so the post-overwrite value is materialized and sparse
    // replay never has to fold across the reset.
    if (doCheckpoint) {
      for (const ch of this._deltaChannelsWithOverwrite)
        channelsToSnapshot.add(ch);
    }

    // create new checkpoint
    this.checkpoint = createCheckpoint(
      this.checkpoint,
      doCheckpoint ? this.channels : undefined,
      this.step,
      {
        id: exiting ? this.checkpoint.id : undefined,
        channelsToSnapshot,
        updatedChannels: this.updatedChannels,
        getNextVersion: doCheckpoint
          ? (current) =>
              this.checkpointerGetNextVersion(current as number | undefined)
          : undefined,
      }
    );

    // Reset counters for channels that just snapshotted, and persist the
    // non-zero remainder into metadata (or clear the field entirely).
    for (const k of channelsToSnapshot) {
      newCounters[k] = [0, 0];
      // The overwrite was just materialized into `channel_values`; stop
      // forcing a snapshot for it.
      this._deltaChannelsWithOverwrite.delete(k);
    }
    const nonZero: Record<string, [number, number]> = {};
    for (const k in newCounters) {
      if (!Object.prototype.hasOwnProperty.call(newCounters, k)) continue;
      const [u, s] = newCounters[k];
      if (u !== 0 || s !== 0) nonZero[k] = [u, s];
    }
    if (Object.keys(nonZero).length > 0) {
      this.checkpointMetadata.counters_since_delta_snapshot = nonZero;
    } else {
      delete this.checkpointMetadata.counters_since_delta_snapshot;
    }

    // Bail if no checkpointer
    if (doCheckpoint) storeCheckpoint(this.checkpoint);

    if (!exiting) {
      // increment step
      this.step += 1;
    }
  }

  /**
   * Stage the exit-mode accumulator of DeltaChannel writes so the final
   * checkpoint can be reconstructed. In "exit" durability per-step writes are
   * not persisted, so delta writes are accumulated across the run and anchored
   * here — under the saved parent, or a freshly-created stub when this is a
   * first run with no persisted parent. Channels that will snapshot in the
   * final checkpoint are excluded (their full value lives in `channel_values`).
   *
   * Must run BEFORE the final `_putCheckpoint` so the stub branch can adjust
   * `checkpointConfig` to anchor the final checkpoint on the stub.
   */
  protected async _putExitDeltaWrites(): Promise<void> {
    if (
      this._exitDeltaWrites === undefined ||
      this._exitDeltaWrites.length === 0 ||
      this.checkpointer == null ||
      this._initialCheckpointConfig === undefined
    ) {
      return;
    }

    const counters =
      this.checkpointMetadata.counters_since_delta_snapshot ?? {};
    const channelsToSnapshot = deltaChannelsToSnapshot(this.channels, counters);
    // Channels that saw an Overwrite are force-snapshotted by the final
    // `_putCheckpoint` (which runs after this), so their accumulated exit
    // writes must NOT also be replayed on top of that snapshot — exclude them.
    for (const ch of this._deltaChannelsWithOverwrite)
      channelsToSnapshot.add(ch);

    const pending = this._exitDeltaWrites.filter(
      ([, , ch]) => !channelsToSnapshot.has(ch)
    );
    if (pending.length === 0) return;

    let anchorConfig: RunnableConfig;
    if (this._hasPersistedParent) {
      // _initialCheckpointConfig points at the saved parent checkpoint.
      anchorConfig = this._initialCheckpointConfig;
    } else {
      // No persisted parent: create a stub empty checkpoint (no parent) and
      // anchor on it, then point the final checkpoint at the stub.
      const stubCp = emptyCheckpoint();
      stubCp.id = this.checkpointIdSaved ?? stubCp.id;
      stubCp.ts = new Date().toISOString();
      const stubPutConfig = patchConfigurable(this._initialCheckpointConfig, {
        [CONFIG_KEY_CHECKPOINT_ID]: undefined,
      });
      anchorConfig = patchConfigurable(this._initialCheckpointConfig, {
        [CONFIG_KEY_CHECKPOINT_ID]: stubCp.id,
      });
      this._trackCheckpointerPromise(
        this.checkpointer.put(
          stubPutConfig,
          stubCp,
          { source: "loop", step: -2, parents: {} },
          {}
        )
      );
      this.checkpointConfig = anchorConfig;
    }

    const anchorWriteConfig = patchConfigurable(anchorConfig, {
      [CONFIG_KEY_CHECKPOINT_NS]: this.config.configurable?.checkpoint_ns ?? "",
      [CONFIG_KEY_CHECKPOINT_ID]:
        anchorConfig.configurable?.[CONFIG_KEY_CHECKPOINT_ID],
    });

    // Group by [step, taskId]; a step-prefixed synthetic task id preserves
    // chronological super-step order under the saver's (task_id, idx) sort.
    const grouped = new Map<string, PendingWrite<string>[]>();
    const order: { key: string; step: number; tid: string }[] = [];
    for (const [step, tid, ch, v] of pending) {
      const key = `${step}\u0000${tid}`;
      let group = grouped.get(key);
      if (group === undefined) {
        group = [];
        grouped.set(key, group);
        order.push({ key, step, tid });
      }
      group.push([ch, v]);
    }
    for (const { key, step, tid } of order) {
      const synthTid = exitDeltaTaskId(step, tid);
      this._trackCheckpointerPromise(
        this.checkpointer.putWrites(
          anchorWriteConfig,
          grouped.get(key)!,
          synthTid
        )
      );
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
      this._trackCheckpointerPromise(
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
