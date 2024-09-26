/* eslint-disable no-param-reassign */
import {
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableLike,
  RunnableSequence,
  _coerceToRunnable,
  ensureConfig,
  getCallbackManagerForConfig,
  patchConfig,
} from "@langchain/core/runnables";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  All,
  BaseCheckpointSaver,
  CheckpointListOptions,
  compareChannelVersions,
  copyCheckpoint,
  emptyCheckpoint,
  PendingWrite,
  uuid5,
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
  isBaseChannel,
} from "../channels/base.js";
import { PregelNode } from "./read.js";
import { validateGraph, validateKeys } from "./validate.js";
import { readChannels } from "./io.js";
import {
  printStepCheckpoint,
  printStepTasks,
  printStepWrites,
  tasksWithWrites,
} from "./debug.js";
import { ChannelWrite, ChannelWriteEntry, PASSTHROUGH } from "./write.js";
import {
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_READ,
  CONFIG_KEY_SEND,
  CONFIG_KEY_STORE,
  ERROR,
  INTERRUPT,
} from "../constants.js";
import {
  NodesType,
  ChannelsType,
  PregelExecutableTask,
  PregelInterface,
  PregelParams,
  SingleStreamMode,
  StateSnapshot,
  StreamMode,
  StreamOutput,
  ChannelsStateType,
  AllStreamOutputTypes,
} from "./types.js";
import {
  GraphRecursionError,
  GraphValueError,
  InvalidUpdateError,
  isGraphInterrupt,
} from "../errors.js";
import { _prepareNextTasks, _localRead, _applyWrites } from "./algo.js";
import { _coerceToDict, getNewChannelVersions, RetryPolicy } from "./utils.js";
import { PregelLoop } from "./loop.js";
import { executeTasksWithRetry } from "./retry.js";
import { BaseStore } from "../store/base.js";
import {
  ChannelKeyPlaceholder,
  isConfiguredManagedValue,
  ManagedValue,
  ManagedValueMapping,
  NoopManagedValue,
  type ManagedValueSpec,
} from "../managed/base.js";
import { patchConfigurable } from "../utils.js";

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export class Channel {
  static subscribeTo(
    channels: string,
    options?: {
      key?: string;
      tags?: string[];
    }
  ): PregelNode;

  static subscribeTo(
    channels: string[],
    options?: {
      tags?: string[];
    }
  ): PregelNode;

  static subscribeTo(
    channels: string | string[],
    options?: {
      key?: string;
      tags?: string[];
    }
  ): PregelNode {
    const { key, tags } = options ?? {};
    if (Array.isArray(channels) && key !== undefined) {
      throw new Error(
        "Can't specify a key when subscribing to multiple channels"
      );
    }

    let channelMappingOrArray: string[] | Record<string, string>;

    if (isString(channels)) {
      if (key) {
        channelMappingOrArray = { [key]: channels };
      } else {
        channelMappingOrArray = [channels];
      }
    } else {
      channelMappingOrArray = Object.fromEntries(
        channels.map((chan) => [chan, chan])
      );
    }

    const triggers: string[] = Array.isArray(channels) ? channels : [channels];

    return new PregelNode({
      channels: channelMappingOrArray,
      triggers,
      tags,
    });
  }

  static writeTo(
    channels: string[],
    kwargs?: Record<string, WriteValue>
  ): ChannelWrite {
    const channelWriteEntries: Array<ChannelWriteEntry> = [];

    for (const channel of channels) {
      channelWriteEntries.push({
        channel,
        value: PASSTHROUGH,
        skipNone: false,
      });
    }

    for (const [key, value] of Object.entries(kwargs ?? {})) {
      if (Runnable.isRunnable(value) || typeof value === "function") {
        channelWriteEntries.push({
          channel: key,
          value: PASSTHROUGH,
          skipNone: true,
          mapper: _coerceToRunnable(value as RunnableLike),
        });
      } else {
        channelWriteEntries.push({
          channel: key,
          value,
          skipNone: false,
        });
      }
    }

    return new ChannelWrite(channelWriteEntries);
  }
}

/**
 * Config for executing the graph.
 */
export interface PregelOptions<
  Nodes extends NodesType,
  Channels extends ChannelsType,
  Mode extends StreamMode = StreamMode
> extends RunnableConfig {
  /** The stream mode for the graph run. Default is ["values"]. */
  streamMode?: Mode;
  inputKeys?: keyof Channels | Array<keyof Channels>;
  /** The output keys to retrieve from the graph run. */
  outputKeys?: keyof Channels | Array<keyof Channels>;
  /** The nodes to interrupt the graph run before. */
  interruptBefore?: All | Array<keyof Nodes>;
  /** The nodes to interrupt the graph run after. */
  interruptAfter?: All | Array<keyof Nodes>;
  /** Enable debug mode for the graph run. */
  debug?: boolean;
}

export class Pregel<Nodes extends NodesType, Channels extends ChannelsType>
  extends Runnable<
    any, // Partial<ChannelsStateType<Channels>>, // input type
    any, // AllStreamOutputTypes<Nodes, Channels>, // output type
    PregelOptions<Nodes, Channels>
  >
  implements PregelInterface<Nodes, Channels>
{
  static lc_name() {
    return "LangGraph";
  }

  // Because Pregel extends `Runnable`.
  lc_namespace = ["langgraph", "pregel"];

  nodes: Nodes;

  channels: Channels;

  inputChannels: keyof Channels | Array<keyof Channels>;

  outputChannels: keyof Channels | Array<keyof Channels>;

  autoValidate: boolean = true;

  streamMode: SingleStreamMode = "values";

  streamChannels?: keyof Channels | Array<keyof Channels>;

  interruptAfter?: Array<keyof Nodes> | All;

  interruptBefore?: Array<keyof Nodes> | All;

  stepTimeout?: number;

  debug: boolean = false;

  checkpointer?: BaseCheckpointSaver;

  retryPolicy?: RetryPolicy;

  store?: BaseStore;

  constructor(fields: PregelParams<Nodes, Channels>) {
    super(fields);

    this.nodes = fields.nodes;
    this.channels = fields.channels;
    this.autoValidate = fields.autoValidate ?? this.autoValidate;
    this.streamMode = fields.streamMode ?? this.streamMode;
    this.inputChannels = fields.inputChannels;
    this.outputChannels = fields.outputChannels;
    this.streamChannels = fields.streamChannels ?? this.streamChannels;
    this.interruptAfter = fields.interruptAfter;
    this.interruptBefore = fields.interruptBefore;
    this.stepTimeout = fields.stepTimeout ?? this.stepTimeout;
    this.debug = fields.debug ?? this.debug;
    this.checkpointer = fields.checkpointer;
    this.retryPolicy = fields.retryPolicy;
    this.store = fields.store;

    if (this.autoValidate) {
      this.validate();
    }
  }

  validate(): this {
    validateGraph<Nodes, Channels>({
      nodes: this.nodes,
      channels: this.channels,
      outputChannels: this.outputChannels,
      inputChannels: this.inputChannels,
      streamChannels: this.streamChannels,
      interruptAfterNodes: this.interruptAfter,
      interruptBeforeNodes: this.interruptBefore,
    });

    return this;
  }

  get streamChannelsList(): Array<keyof Channels> {
    if (Array.isArray(this.streamChannels)) {
      return this.streamChannels;
    } else if (this.streamChannels) {
      return [this.streamChannels];
    } else {
      return Object.keys(this.channels);
    }
  }

  get streamChannelsAsIs(): keyof Channels | Array<keyof Channels> {
    if (this.streamChannels) {
      return this.streamChannels;
    } else {
      return Object.keys(this.channels);
    }
  }

  /**
   * Get the current state of the graph.
   */
  async getState(config: RunnableConfig): Promise<StateSnapshot> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }

    const saved = await this.checkpointer.getTuple(config);
    const checkpoint = saved ? saved.checkpoint : emptyCheckpoint();
    const channels = emptyChannels(
      this.channels as Record<string, BaseChannel>,
      checkpoint
    );
    // Pass `skipManaged: true` as managed values should not be returned in get state calls.
    const { managed } = await this.prepareSpecs(config, { skipManaged: true });

    const nextTasks = _prepareNextTasks(
      checkpoint,
      this.nodes,
      channels,
      managed,
      saved !== undefined ? saved.config : config,
      false,
      { step: saved ? (saved.metadata?.step ?? -1) + 1 : -1 }
    );
    return {
      values: readChannels(
        channels,
        this.streamChannelsAsIs as string | string[]
      ),
      next: nextTasks.map((task) => task.name),
      tasks: tasksWithWrites(nextTasks, saved?.pendingWrites ?? []),
      metadata: saved?.metadata,
      config: saved ? saved.config : config,
      createdAt: saved?.checkpoint.ts,
      parentConfig: saved?.parentConfig,
    };
  }

  /**
   * Get the history of the state of the graph.
   */
  async *getStateHistory(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncIterableIterator<StateSnapshot> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }
    // Pass `skipManaged: true` as managed values should not be returned in get state calls.
    const { managed } = await this.prepareSpecs(config, { skipManaged: true });

    for await (const saved of this.checkpointer.list(config, options)) {
      const channels = emptyChannels(
        this.channels as Record<string, BaseChannel>,
        saved.checkpoint
      );

      const nextTasks = _prepareNextTasks(
        saved.checkpoint,
        this.nodes,
        channels,
        managed,
        saved.config,
        false,
        { step: -1 }
      );
      yield {
        values: readChannels(
          channels,
          this.streamChannelsAsIs as string | string[]
        ),
        next: nextTasks.map((task) => task.name),
        tasks: tasksWithWrites(nextTasks, saved.pendingWrites ?? []),
        metadata: saved.metadata,
        config: saved.config,
        createdAt: saved.checkpoint.ts,
        parentConfig: saved.parentConfig,
      };
    }
  }

  /**
   * Update the state of the graph with the given values, as if they came from
   * node `as_node`. If `as_node` is not provided, it will be set to the last node
   * that updated the state, if not ambiguous.
   */
  async updateState(
    config: RunnableConfig,
    values: Record<string, unknown> | unknown,
    asNode?: keyof Nodes
  ): Promise<RunnableConfig> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }

    // Get the latest checkpoint
    const saved = await this.checkpointer.getTuple(config);
    const checkpoint = saved
      ? copyCheckpoint(saved.checkpoint)
      : emptyCheckpoint();
    const checkpointPreviousVersions = saved?.checkpoint.channel_versions ?? {};
    const step = saved?.metadata?.step ?? -1;

    // merge configurable fields with previous checkpoint config
    const checkpointConfig = {
      ...config,
      configurable: {
        ...config.configurable,
        // TODO: add proper support for updating nested subgraph state
        checkpoint_ns: "",
        ...saved?.config.configurable,
      },
    };

    // Find last node that updated the state, if not provided
    if (values == null && asNode === undefined) {
      return await this.checkpointer.put(
        checkpointConfig,
        createCheckpoint(checkpoint, undefined, step),
        {
          source: "update",
          step,
          writes: {},
        },
        {}
      );
    }

    const nonNullVersion = Object.values(checkpoint.versions_seen)
      .map((seenVersions) => {
        return Object.values(seenVersions);
      })
      .flat()
      .find((v) => !!v);
    if (asNode === undefined && nonNullVersion === undefined) {
      if (
        typeof this.inputChannels === "string" &&
        this.nodes[this.inputChannels] !== undefined
      ) {
        asNode = this.inputChannels;
      }
    } else if (asNode === undefined) {
      // TODO: Double check
      const lastSeenByNode = Object.entries(checkpoint.versions_seen)
        .map(([n, seen]) => {
          return Object.values(seen).map((v) => {
            return [v, n] as const;
          });
        })
        .flat()
        .sort(([aNumber], [bNumber]) =>
          compareChannelVersions(aNumber, bNumber)
        );
      // if two nodes updated the state at the same time, it's ambiguous
      if (lastSeenByNode) {
        if (lastSeenByNode.length === 1) {
          // eslint-disable-next-line prefer-destructuring
          asNode = lastSeenByNode[0][1];
        } else if (
          lastSeenByNode[lastSeenByNode.length - 1][0] !==
          lastSeenByNode[lastSeenByNode.length - 2][0]
        ) {
          // eslint-disable-next-line prefer-destructuring
          asNode = lastSeenByNode[lastSeenByNode.length - 1][1];
        }
      }
    }
    if (asNode === undefined) {
      throw new InvalidUpdateError(`Ambiguous update, specify "asNode"`);
    }
    if (this.nodes[asNode] === undefined) {
      throw new InvalidUpdateError(
        `Node "${asNode.toString()}" does not exist`
      );
    }
    // update channels
    const channels = emptyChannels(
      this.channels as Record<string, BaseChannel>,
      checkpoint
    );

    // Pass `skipManaged: true` as managed values are not used/relevant in update state calls.
    const { managed } = await this.prepareSpecs(config, { skipManaged: true });

    // run all writers of the chosen node
    const writers = this.nodes[asNode].getWriters();
    if (!writers.length) {
      throw new InvalidUpdateError(
        `No writers found for node "${asNode.toString()}"`
      );
    }
    const task: PregelExecutableTask<keyof Nodes, keyof Channels> = {
      name: asNode,
      input: values,
      proc:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writers.length > 1 ? RunnableSequence.from(writers as any) : writers[0],
      writes: [],
      triggers: [INTERRUPT],
      id: uuid5(INTERRUPT, checkpoint.id),
    };

    // execute task
    await task.proc.invoke(
      task.input,
      patchConfig(config, {
        runName: config.runName ?? `${this.getName()}UpdateState`,
        configurable: {
          [CONFIG_KEY_SEND]: (items: [keyof Channels, unknown][]) =>
            task.writes.push(...items),
          [CONFIG_KEY_READ]: (
            select_: Array<keyof Channels> | keyof Channels,
            fresh_: boolean = false
          ) =>
            _localRead(
              step,
              checkpoint,
              channels,
              managed,
              // TODO: Why does keyof StrRecord allow number and symbol?
              task as PregelExecutableTask<string, string>,
              select_ as string | string[],
              fresh_
            ),
        },
      })
    );

    if (saved !== undefined) {
      await this.checkpointer.putWrites(
        checkpointConfig,
        task.writes as PendingWrite[],
        task.id
      );
    }

    // apply to checkpoint
    // TODO: Why does keyof StrRecord allow number and symbol?
    _applyWrites(
      checkpoint,
      channels,
      [task as PregelExecutableTask<string, string>],
      this.checkpointer.getNextVersion.bind(this.checkpointer)
    );

    const newVersions = getNewChannelVersions(
      checkpointPreviousVersions,
      checkpoint.channel_versions
    );
    return await this.checkpointer.put(
      checkpointConfig,
      createCheckpoint(checkpoint, channels, step + 1),
      {
        source: "update",
        step: step + 1,
        writes: { [asNode]: values },
      },
      newVersions
    );
  }

  _defaults(config: PregelOptions<Nodes, Channels>): [
    boolean, // debug
    SingleStreamMode[], // stream mode
    string | string[], // input keys
    string | string[], // output keys
    RunnableConfig, // config without pregel keys
    All | string[], // interrupt before
    All | string[], // interrupt after
    BaseCheckpointSaver | undefined
  ] {
    const {
      debug,
      streamMode,
      inputKeys,
      outputKeys,
      interruptAfter,
      interruptBefore,
      ...rest
    } = config;
    const defaultDebug = debug !== undefined ? debug : this.debug;

    let defaultOutputKeys = outputKeys;
    if (defaultOutputKeys === undefined) {
      defaultOutputKeys = this.streamChannelsAsIs;
    } else {
      validateKeys(defaultOutputKeys, this.channels);
    }

    let defaultInputKeys = inputKeys;
    if (defaultInputKeys === undefined) {
      defaultInputKeys = this.inputChannels;
    } else {
      validateKeys(defaultInputKeys, this.channels);
    }

    const defaultInterruptBefore =
      interruptBefore ?? this.interruptBefore ?? [];

    const defaultInterruptAfter = interruptAfter ?? this.interruptAfter ?? [];

    let defaultStreamMode: SingleStreamMode[];
    if (streamMode !== undefined) {
      defaultStreamMode = Array.isArray(streamMode) ? streamMode : [streamMode];
    } else {
      defaultStreamMode = [this.streamMode];
    }

    let defaultCheckpointer: BaseCheckpointSaver | undefined;
    if (
      config.configurable !== undefined &&
      config.configurable[CONFIG_KEY_READ] !== undefined
    ) {
      defaultStreamMode = ["values"];
    }
    if (
      config !== undefined &&
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] !== undefined &&
      (defaultInterruptAfter.length > 0 || defaultInterruptBefore.length > 0)
    ) {
      defaultCheckpointer = config.configurable[CONFIG_KEY_CHECKPOINTER];
    } else {
      defaultCheckpointer = this.checkpointer;
    }

    return [
      defaultDebug,
      defaultStreamMode,
      defaultInputKeys as string | string[],
      defaultOutputKeys as string | string[],
      rest,
      defaultInterruptBefore as All | string[],
      defaultInterruptAfter as All | string[],
      defaultCheckpointer,
    ];
  }

  /**
   * Stream graph steps for a single input.
   * @param input The input to the graph.
   * @param options The configuration to use for the run.
   * @param options.streamMode The mode to stream output. Defaults to value set on initialization.
   *   Options are "values", "updates", and "debug". Default is "values".
   *     values: Emit the current values of the state for each step.
   *     updates: Emit only the updates to the state for each step.
   *         Output is a dict with the node name as key and the updated values as value.
   *     debug: Emit debug events for each step.
   * @param options.outputKeys The keys to stream. Defaults to all non-context channels.
   * @param options.interruptBefore Nodes to interrupt before.
   * @param options.interruptAfter Nodes to interrupt after.
   * @param options.debug Whether to print debug information during execution.
   */
  override async stream<Mode extends StreamMode>(
    input: Partial<ChannelsStateType<Channels>>,
    options?: Partial<PregelOptions<Nodes, Channels, Mode>>
  ): Promise<IterableReadableStream<StreamOutput<Mode, Nodes, Channels>>> {
    return super.stream(input, options) as Promise<
      IterableReadableStream<StreamOutput<Mode, Nodes, Channels>>
    >;
  }

  protected async prepareSpecs(
    config: RunnableConfig,
    options?: {
      // Equivalent to the `skip_context` option in Python, but renamed
      // to `managed` since JS does not implement the `Context` class.
      skipManaged?: boolean;
    }
  ) {
    const configForManaged = patchConfigurable(config, {
      [CONFIG_KEY_STORE]: this.store,
    });
    const channelSpecs: Record<string, BaseChannel> = {};
    const managedSpecs: Record<string, ManagedValueSpec> = {};

    for (const [name, spec] of Object.entries(this.channels)) {
      if (isBaseChannel(spec)) {
        channelSpecs[name] = spec;
      } else if (options?.skipManaged) {
        managedSpecs[name] = {
          cls: NoopManagedValue,
          params: { config: {} },
        };
      } else {
        managedSpecs[name] = spec;
      }
    }
    const managed = new ManagedValueMapping(
      await Object.entries(managedSpecs).reduce(
        async (accPromise, [key, value]) => {
          const acc = await accPromise;
          let initializedValue;

          if (isConfiguredManagedValue(value)) {
            if (
              "key" in value.params &&
              value.params.key === ChannelKeyPlaceholder
            ) {
              value.params.key = key;
            }
            initializedValue = await value.cls.initialize(
              configForManaged,
              value.params
            );
          } else {
            initializedValue = await value.initialize(configForManaged);
          }

          if (initializedValue !== undefined) {
            acc.push([key, initializedValue]);
          }

          return acc;
        },
        Promise.resolve([] as [string, ManagedValue][])
      )
    );
    return {
      channelSpecs,
      managed,
    };
  }

  override async *_streamIterator<Mode extends StreamMode>(
    input: Partial<ChannelsStateType<Channels>>,
    options?: Partial<PregelOptions<Nodes, Channels, Mode>>
  ): AsyncGenerator<StreamOutput<Mode, Nodes, Channels>> {
    const inputConfig = ensureConfig(options);
    if (
      inputConfig.recursionLimit === undefined ||
      inputConfig.recursionLimit < 1
    ) {
      throw new Error(`Passed "recursionLimit" must be at least 1.`);
    }
    if (
      this.checkpointer !== undefined &&
      inputConfig.configurable === undefined
    ) {
      throw new Error(
        `Checkpointer requires one or more of the following "configurable" keys: "thread_id", "checkpoint_ns", "checkpoint_id"`
      );
    }
    const callbackManager = await getCallbackManagerForConfig(inputConfig);
    const runManager = await callbackManager?.handleChainStart(
      this.toJSON(),
      _coerceToDict(input, "input"),
      inputConfig.runId,
      undefined,
      undefined,
      undefined,
      inputConfig?.runName ?? this.getName()
    );
    delete inputConfig.runId;
    // assign defaults
    const [
      debug,
      streamMode,
      ,
      outputKeys,
      config,
      interruptBefore,
      interruptAfter,
      checkpointer,
    ] = this._defaults(inputConfig);

    const { channelSpecs, managed } = await this.prepareSpecs(config);

    let loop;
    try {
      loop = await PregelLoop.initialize({
        input,
        config,
        checkpointer,
        nodes: this.nodes,
        channelSpecs,
        managed,
        outputKeys,
        streamKeys: this.streamChannelsAsIs as string | string[],
        store: this.store,
      });
      while (
        await loop.tick({
          inputKeys: this.inputChannels as string | string[],
          interruptAfter,
          interruptBefore,
          manager: runManager,
        })
      ) {
        if (debug) {
          printStepCheckpoint(
            loop.checkpointMetadata.step,
            loop.channels,
            this.streamChannelsList as string[]
          );
        }
        while (loop.stream.length > 0) {
          const nextItem = loop.stream.shift();
          if (nextItem === undefined) {
            throw new Error("Data structure error.");
          }
          if (streamMode.includes(nextItem[0])) {
            if (streamMode.length === 1) {
              yield nextItem[1];
            } else {
              yield nextItem;
            }
          }
        }
        if (debug) {
          printStepTasks(loop.step, loop.tasks);
        }
        // execute tasks, and wait for one to fail or all to finish.
        // each task is independent from all other concurrent tasks
        // yield updates/debug output as each task finishes
        const taskStream = executeTasksWithRetry(
          loop.tasks.filter((task) => task.writes.length === 0),
          {
            stepTimeout: this.stepTimeout,
            signal: config.signal,
            retryPolicy: this.retryPolicy,
          }
        );
        // Timeouts will be thrown
        for await (const { task, error } of taskStream) {
          if (error !== undefined) {
            if (isGraphInterrupt(error)) {
              loop.putWrites(
                task.id,
                error.interrupts.map((interrupt) => [INTERRUPT, interrupt])
              );
            } else {
              loop.putWrites(task.id, [
                [ERROR, { message: error.message, name: error.name }],
              ]);
            }
          } else {
            loop.putWrites(task.id, task.writes);
          }
          while (loop.stream.length > 0) {
            const nextItem = loop.stream.shift();
            if (nextItem === undefined) {
              throw new Error("Data structure error.");
            }
            if (streamMode.includes(nextItem[0])) {
              if (streamMode.length === 1) {
                yield nextItem[1];
              } else {
                yield nextItem;
              }
            }
          }
          if (error !== undefined && !isGraphInterrupt(error)) {
            throw error;
          }
        }

        if (debug) {
          printStepWrites(
            loop.step,
            loop.tasks.map((task) => task.writes).flat(),
            this.streamChannelsList as string[]
          );
        }
      }
      while (loop.stream.length > 0) {
        const nextItem = loop.stream.shift();
        if (nextItem === undefined) {
          throw new Error("Data structure error.");
        }
        if (streamMode.includes(nextItem[0])) {
          if (streamMode.length === 1) {
            yield nextItem[1];
          } else {
            yield nextItem;
          }
        }
      }
      if (loop.status === "out_of_steps") {
        throw new GraphRecursionError(
          [
            `Recursion limit of ${config.recursionLimit} reached`,
            "without hitting a stop condition. You can increase the",
            `limit by setting the "recursionLimit" config key.`,
          ].join(" ")
        );
      }
      await Promise.all(loop?.checkpointerPromises ?? []);
      await runManager?.handleChainEnd(readChannels(loop.channels, outputKeys));
    } catch (e) {
      await runManager?.handleChainError(e);
      throw e;
    } finally {
      // Call `.stop()` again incase it was not called in the loop, e.g due to an error.
      if (loop) {
        loop.store?.stop();
      }
      await Promise.all([
        loop?.checkpointerPromises ?? [],
        ...Array.from(managed.values()).map((mv) => mv.promises()),
      ]);
    }
  }

  /**
   * Run the graph with a single input and config.
   * @param input The input to the graph.
   * @param options The configuration to use for the run.
   * @param options.streamMode The mode to stream output. Defaults to value set on initialization.
   *   Options are "values", "updates", and "debug". Default is "values".
   *     values: Emit the current values of the state for each step.
   *     updates: Emit only the updates to the state for each step.
   *         Output is a dict with the node name as key and the updated values as value.
   *     debug: Emit debug events for each step.
   * @param options.outputKeys The keys to stream. Defaults to all non-context channels.
   * @param options.interruptBefore Nodes to interrupt before.
   * @param options.interruptAfter Nodes to interrupt after.
   * @param options.debug Whether to print debug information during execution.
   */
  override async invoke<Mode extends StreamMode>(
    input: ChannelsStateType<Channels>,
    options?: Partial<PregelOptions<Nodes, Channels, Mode>>
  ): Promise<StreamOutput<Mode, Nodes, Channels>> {
    const streamMode = options?.streamMode ?? ("values" as const);
    const config = {
      ...ensureConfig(options),
      outputKeys: options?.outputKeys ?? this.outputChannels,
      streamMode,
    };
    const chunks: StreamOutput<Mode, Nodes, Channels>[] = [];
    const stream = await this.stream(input, config);
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    if (streamMode === "values") {
      return chunks[chunks.length - 1];
    }
    return chunks;
  }
}
