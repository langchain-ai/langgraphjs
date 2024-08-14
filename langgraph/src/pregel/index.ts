/* eslint-disable no-param-reassign */
import {
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableLike,
  RunnableSequence,
  _coerceToRunnable,
  ensureConfig,
  mergeConfigs,
  patchConfig,
} from "@langchain/core/runnables";
import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
} from "../channels/base.js";
import {
  BaseCheckpointSaver,
  Checkpoint,
  ReadonlyCheckpoint,
  copyCheckpoint,
  emptyCheckpoint,
  getChannelVersion,
  getVersionSeen,
} from "../checkpoint/base.js";
import { PregelNode } from "./read.js";
import { validateGraph, validateKeys } from "./validate.js";
import {
  mapInput,
  mapOutputUpdates,
  mapOutputValues,
  readChannel,
  readChannels,
  single,
} from "./io.js";
import { ChannelWrite, ChannelWriteEntry, PASSTHROUGH } from "./write.js";
import {
  _isSend,
  _isSendInterface,
  CONFIG_KEY_READ,
  CONFIG_KEY_SEND,
  INTERRUPT,
  Send,
  TAG_HIDDEN,
  TASKS,
} from "../constants.js";
import {
  All,
  PregelExecutableTask,
  PregelTaskDescription,
  StateSnapshot,
} from "./types.js";
import {
  EmptyChannelError,
  GraphRecursionError,
  GraphValueError,
  InvalidUpdateError,
} from "../errors.js";

const DEFAULT_LOOP_LIMIT = 25;

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function* prefixGenerator<T>(
  generator: Generator<T>,
  prefix: string | undefined
) {
  if (!prefix) yield* generator;
  for (const value of generator) yield [prefix, value];
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

export type StreamMode = "values" | "updates";

/**
 * Construct a type with a set of properties K of type T
 */
type StrRecord<K extends string, T> = {
  [P in K]: T;
};

export interface PregelInterface<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
> {
  nodes: Nn;

  channels: Cc;

  inputs: keyof Cc | Array<keyof Cc>;

  outputs: keyof Cc | Array<keyof Cc>;
  /**
   * @default true
   */
  autoValidate?: boolean;
  /**
   * @default "values"
   */
  streamMode?: StreamMode | StreamMode[];

  streamChannels?: keyof Cc | Array<keyof Cc>;
  /**
   * @default []
   */
  interruptAfter?: Array<keyof Nn> | All;
  /**
   * @default []
   */
  interruptBefore?: Array<keyof Nn> | All;
  /**
   * @default undefined
   */
  stepTimeout?: number;
  /**
   * @default false
   */
  debug?: boolean;

  checkpointer?: BaseCheckpointSaver;
}

export interface PregelOptions<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
> extends RunnableConfig {
  streamMode?: StreamMode | StreamMode[];
  inputKeys?: keyof Cc | Array<keyof Cc>;
  outputKeys?: keyof Cc | Array<keyof Cc>;
  interruptBefore?: All | Array<keyof Nn>;
  interruptAfter?: All | Array<keyof Nn>;
  debug?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelOutputType = any;

export class Pregel<
    Nn extends StrRecord<string, PregelNode>,
    Cc extends StrRecord<string, BaseChannel>
  >
  extends Runnable<PregelInputType, PregelOutputType, PregelOptions<Nn, Cc>>
  implements PregelInterface<Nn, Cc>
{
  static lc_name() {
    return "LangGraph";
  }

  // Because Pregel extends `Runnable`.
  lc_namespace = ["langgraph", "pregel"];

  nodes: Nn;

  channels: Cc;

  inputs: keyof Cc | Array<keyof Cc>;

  outputs: keyof Cc | Array<keyof Cc>;

  autoValidate: boolean = true;

  streamMode: StreamMode[] = ["values"];

  streamChannels?: keyof Cc | Array<keyof Cc>;

  interruptAfter?: Array<keyof Nn> | All;

  interruptBefore?: Array<keyof Nn> | All;

  stepTimeout?: number;

  debug: boolean = false;

  checkpointer?: BaseCheckpointSaver;

  constructor(fields: PregelInterface<Nn, Cc>) {
    super(fields);

    let streamMode = fields.streamMode;
    if (streamMode != null && !Array.isArray(streamMode)) {
      streamMode = [streamMode];
    }

    this.nodes = fields.nodes;
    this.channels = fields.channels;
    this.autoValidate = fields.autoValidate ?? this.autoValidate;
    this.streamMode = streamMode ?? this.streamMode;
    this.outputs = fields.outputs;
    this.streamChannels = fields.streamChannels ?? this.streamChannels;
    this.interruptAfter = fields.interruptAfter;
    this.interruptBefore = fields.interruptBefore;
    this.inputs = fields.inputs;
    this.stepTimeout = fields.stepTimeout ?? this.stepTimeout;
    this.debug = fields.debug ?? this.debug;
    this.checkpointer = fields.checkpointer;

    // Bind the method to the instance
    this._transform = this._transform.bind(this);

    if (this.autoValidate) {
      this.validate();
    }
  }

  validate(): this {
    validateGraph({
      nodes: this.nodes,
      channels: this.channels,
      outputChannels: this.outputs,
      inputChannels: this.inputs,
      streamChannels: this.streamChannels,
      interruptAfterNodes: this.interruptAfter,
      interruptBeforeNodes: this.interruptBefore,
    });

    return this;
  }

  get streamChannelsList(): Array<keyof Cc> {
    if (Array.isArray(this.streamChannels)) {
      return this.streamChannels;
    } else if (this.streamChannels) {
      return [this.streamChannels];
    } else {
      return Object.keys(this.channels);
    }
  }

  get streamChannelsAsIs(): keyof Cc | Array<keyof Cc> {
    if (this.streamChannels) {
      return this.streamChannels;
    } else {
      return Object.keys(this.channels);
    }
  }

  async getState(config: RunnableConfig): Promise<StateSnapshot> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }

    const saved = await this.checkpointer.getTuple(config);
    const checkpoint = saved ? saved.checkpoint : emptyCheckpoint();
    const channels = emptyChannels(this.channels, checkpoint);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_, nextTasks] = _prepareNextTasks(
      checkpoint,
      this.nodes,
      channels,
      false,
      { step: -1 }
    );
    return {
      values: readChannels(channels, this.streamChannelsAsIs),
      next: nextTasks.map((task) => task.name),
      metadata: saved?.metadata,
      config: saved ? saved.config : config,
      createdAt: saved?.checkpoint.ts,
      parentConfig: saved?.parentConfig,
    };
  }

  async *getStateHistory(
    config: RunnableConfig,
    limit?: number,
    before?: RunnableConfig
  ): AsyncIterableIterator<StateSnapshot> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }
    for await (const saved of this.checkpointer.list(config, limit, before)) {
      const channels = emptyChannels(this.channels, saved.checkpoint);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_, nextTasks] = _prepareNextTasks(
        saved.checkpoint,
        this.nodes,
        channels,
        false,
        { step: -1 }
      );
      yield {
        values: readChannels(channels, this.streamChannelsAsIs),
        next: nextTasks.map((task) => task.name),
        metadata: saved.metadata,
        config: saved.config,
        createdAt: saved.checkpoint.ts,
        parentConfig: saved.parentConfig,
      };
    }
  }

  async updateState(
    config: RunnableConfig,
    values: Record<string, unknown> | unknown,
    asNode?: keyof Nn
  ): Promise<RunnableConfig> {
    if (!this.checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }

    // Get the latest checkpoint
    const saved = await this.checkpointer.getTuple(config);
    const checkpoint = saved
      ? copyCheckpoint(saved.checkpoint)
      : emptyCheckpoint();
    // Find last that updated the state, if not provided
    const maxSeens = Object.entries(checkpoint.versions_seen).reduce(
      (acc, [node, versions]) => {
        const maxSeen = Math.max(...Object.values(versions));
        if (maxSeen) {
          if (!acc[maxSeen]) {
            acc[maxSeen] = [];
          }
          acc[maxSeen].push(node);
        }
        return acc;
      },
      {} as Record<number, string[]>
    );
    if (!asNode && !Object.keys(maxSeens).length) {
      if (!Array.isArray(this.inputs) && this.inputs in this.nodes) {
        asNode = this.inputs as keyof Nn;
      }
    } else if (!asNode) {
      const maxSeen = Math.max(...Object.keys(maxSeens).map(Number));
      const nodes = maxSeens[maxSeen];
      if (nodes.length === 1) {
        asNode = nodes[0] as keyof Nn;
      }
    }
    if (!asNode) {
      throw new InvalidUpdateError("Ambiguous update, specify as_node");
    }
    // update channels
    const channels = emptyChannels(this.channels, checkpoint);
    // create task to run all writers of the chosen node
    const writers = this.nodes[asNode].getWriters();
    if (!writers.length) {
      throw new InvalidUpdateError(
        `No writers found for node ${asNode as string}`
      );
    }
    const task: PregelExecutableTask<keyof Nn, keyof Cc> = {
      name: asNode,
      input: values,
      proc:
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writers.length > 1 ? RunnableSequence.from(writers as any) : writers[0],
      writes: [],
      config: undefined,
    };
    // execute task
    await task.proc.invoke(
      task.input,
      patchConfig(config, {
        runName: `${this.name}UpdateState`,
        configurable: {
          [CONFIG_KEY_SEND]: (items: [keyof Cc, unknown][]) =>
            task.writes.push(...items),
          [CONFIG_KEY_READ]: _localRead.bind(
            undefined,
            checkpoint,
            channels,
            task.writes as Array<[string, unknown]>
          ),
        },
      })
    );
    // apply to checkpoint and save
    _applyWrites(checkpoint, channels, task.writes);
    const step = (saved?.metadata?.step ?? -2) + 1;
    return await this.checkpointer.put(
      saved?.config ?? config,
      createCheckpoint(checkpoint, channels, step),
      {
        source: "update",
        step,
        writes: { [asNode]: values },
      }
    );
  }

  _defaults(config: PregelOptions<Nn, Cc>): [
    boolean, // debug
    StreamMode[], // stream mode
    keyof Cc | Array<keyof Cc>, // input keys
    keyof Cc | Array<keyof Cc>, // output keys
    RunnableConfig, // config without pregel keys
    All | Array<keyof Nn>, // interrupt before
    All | Array<keyof Nn> // interrupt after,
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
      defaultInputKeys = this.inputs;
    } else {
      validateKeys(defaultInputKeys, this.channels);
    }

    const defaultInterruptBefore =
      interruptBefore ?? this.interruptBefore ?? [];

    const defaultInterruptAfter = interruptAfter ?? this.interruptAfter ?? [];

    let defaultStreamMode: StreamMode[];
    if (streamMode !== undefined) {
      defaultStreamMode = Array.isArray(streamMode) ? streamMode : [streamMode];
    } else {
      defaultStreamMode = this.streamMode;
    }

    if (
      config.configurable !== undefined &&
      config.configurable[CONFIG_KEY_READ] !== undefined
    ) {
      defaultStreamMode = ["values"];
    }

    return [
      defaultDebug,
      defaultStreamMode,
      defaultInputKeys,
      defaultOutputKeys,
      rest,
      defaultInterruptBefore,
      defaultInterruptAfter,
    ];
  }

  async *_transform(
    input: AsyncGenerator<PregelInputType>,
    runManager?: CallbackManagerForChainRun,
    config: PregelOptions<Nn, Cc> = {}
  ): AsyncGenerator<PregelOutputType> {
    const bg: Promise<unknown>[] = [];
    try {
      if (config.recursionLimit && config.recursionLimit < 1) {
        throw new GraphValueError(
          `Recursion limit must be greater than 0, got ${config.recursionLimit}`
        );
      }
      if (this.checkpointer && !config.configurable) {
        throw new GraphValueError(
          `Checkpointer requires one or more of the following 'configurable' keys: thread_id, checkpoint_id`
        );
      }
      // assign defaults
      const [
        debug,
        streamMode,
        inputKeys,
        outputKeys,
        restConfig,
        interruptBefore,
        interruptAfter,
      ] = this._defaults(config);
      // copy nodes to ignore mutations during execution
      const processes = { ...this.nodes };
      // get checkpoint, or create an empty one
      const saved = this.checkpointer
        ? await this.checkpointer.getTuple(config)
        : null;
      let checkpoint = saved ? saved.checkpoint : emptyCheckpoint();
      let checkpointConfig = saved ? saved.config : config;
      let start = (saved?.metadata?.step ?? -2) + 1;
      // create channels from checkpoint
      const channels = emptyChannels(this.channels, checkpoint);
      // map inputs to channel updates
      const inputPendingWrites: Array<[keyof Cc, unknown]> = [];
      for await (const c of input) {
        for (const value of mapInput(inputKeys, c)) {
          inputPendingWrites.push(value);
        }
      }
      if (inputPendingWrites.length) {
        // discard any unfinished tasks from previous checkpoint
        const discarded = _prepareNextTasks(
          checkpoint,
          processes,
          channels,
          true,
          { step: -1 }
        );
        checkpoint = discarded[0]; // eslint-disable-line prefer-destructuring
        // apply input writes
        _applyWrites(checkpoint, channels, inputPendingWrites);
        // save input checkpoint
        if (this.checkpointer) {
          checkpoint = createCheckpoint(checkpoint, channels, start);
          bg.push(
            this.checkpointer.put(checkpointConfig, checkpoint, {
              source: "input",
              step: start,
              writes: Object.fromEntries(inputPendingWrites),
            })
          );
          checkpointConfig = {
            configurable: {
              ...checkpointConfig.configurable,
              checkpoint_id: checkpoint.id,
            },
          };
        }
        // increment start to 0
        start += 1;
      } else {
        checkpoint = copyCheckpoint(checkpoint);
        for (const k of this.streamChannelsList) {
          const version = checkpoint.channel_versions[k as string] ?? 0;
          if (!checkpoint.versions_seen[INTERRUPT]) {
            checkpoint.versions_seen[INTERRUPT] = {};
          }
          checkpoint.versions_seen[INTERRUPT][k as string] = version;
        }
      }

      // Similarly to Bulk Synchronous Parallel / Pregel model
      // computation proceeds in steps, while there are channel updates
      // channel updates from step N are only visible in step N+1
      // channels are guaranteed to be immutable for the duration of the step,
      // with channel updates applied only at the transition between steps
      const stop = start + (config.recursionLimit ?? DEFAULT_LOOP_LIMIT);
      for (let step = start; step < stop + 1; step += 1) {
        const [nextCheckpoint, nextTasks] = _prepareNextTasks(
          checkpoint,
          processes,
          channels,
          true,
          { step }
        );

        // if no more tasks, we're done
        if (nextTasks.length === 0 && step === start) {
          throw new GraphValueError(`No tasks to run in graph.`);
        } else if (nextTasks.length === 0) {
          break;
        } else if (step === stop) {
          throw new GraphRecursionError(
            `Recursion limit of ${config.recursionLimit} reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.`
          );
        }

        // before execution, check if we should interrupt
        if (
          _shouldInterrupt(
            checkpoint,
            interruptBefore,
            this.streamChannelsList,
            nextTasks
          )
        ) {
          break;
        } else {
          checkpoint = nextCheckpoint;
        }

        if (debug) {
          console.log(nextTasks);
        }

        const tasksWithConfig = nextTasks.map(
          // eslint-disable-next-line no-loop-func
          (task, i) =>
            [
              task.proc,
              task.input,
              patchConfig(
                mergeConfigs(restConfig, processes[task.name].config, {
                  metadata: {
                    langgraph_step: step,
                    langgraph_node: task.name,
                    langgraph_triggers: [TASKS],
                    langgraph_task_idx: i,
                  },
                }),
                {
                  callbacks: runManager?.getChild(`graph:step:${step}`),
                  runName: task.name as string,
                  configurable: {
                    ...config.configurable,
                    [CONFIG_KEY_SEND]: (items: [keyof Cc, unknown][]) =>
                      task.writes.push(...items),
                    [CONFIG_KEY_READ]: _localRead.bind(
                      undefined,
                      checkpoint,
                      channels,
                      task.writes as Array<[string, unknown]>
                    ),
                  },
                }
              ),
            ] as const
        );

        // execute tasks, and wait for one to fail or all to finish.
        // each task is independent from all other concurrent tasks
        const tasks = tasksWithConfig.map(
          ([proc, input, updatedConfig]) =>
            () =>
              proc.invoke(input, updatedConfig)
        );

        await executeTasks(tasks, this.stepTimeout, config.signal);

        // combine pending writes from all tasks
        const pendingWrites: Array<[keyof Cc, unknown]> = [];
        for (const task of nextTasks) {
          pendingWrites.push(...task.writes);
        }

        // apply writes to channels
        _applyWrites(checkpoint, channels, pendingWrites);

        if (streamMode.includes("updates")) {
          // TODO: Refactor
          for await (const task of nextTasks) {
            yield* prefixGenerator(
              mapOutputUpdates(outputKeys, [task]),
              streamMode.length > 1 ? "updates" : undefined
            );
          }
        }

        // yield current value and checkpoint view
        if (streamMode.includes("values")) {
          yield* prefixGenerator(
            mapOutputValues(outputKeys, pendingWrites, channels),
            streamMode.length > 1 ? "values" : undefined
          );
        }

        // save end of step checkpoint
        if (this.checkpointer) {
          checkpoint = createCheckpoint(checkpoint, channels, step);
          bg.push(
            this.checkpointer.put(checkpointConfig, checkpoint, {
              source: "loop",
              step,
              writes: single(
                this.streamMode.includes("values")
                  ? mapOutputValues(outputKeys, pendingWrites, channels)
                  : mapOutputUpdates(outputKeys, nextTasks)
              ),
            })
          );
          checkpointConfig = {
            configurable: {
              ...checkpointConfig.configurable,
              checkpoint_id: checkpoint.id,
            },
          };
        }

        if (
          _shouldInterrupt(
            checkpoint,
            interruptAfter,
            this.streamChannelsList,
            nextTasks
          )
        ) {
          break;
        }
      }
    } finally {
      await Promise.all(bg);
    }
  }

  async invoke(
    input: PregelInputType,
    options?: PregelOptions<Nn, Cc>
  ): Promise<PregelOutputType> {
    const config = ensureConfig(options);
    if (!config?.outputKeys) {
      config.outputKeys = this.outputs;
    }
    if (!config?.streamMode) {
      config.streamMode = "values";
    }

    let latest: PregelOutputType | undefined;
    for await (const chunk of await this.stream(input, config)) {
      latest = chunk;
    }
    if (!latest) {
      return undefined as PregelOutputType;
    }
    return latest;
  }

  async stream(
    input: PregelInputType,
    config?: PregelOptions<Nn, Cc>
  ): Promise<IterableReadableStream<PregelOutputType>> {
    const inputIterator: AsyncGenerator<PregelInputType> = (async function* () {
      yield input;
    })();
    return IterableReadableStream.fromAsyncGenerator(
      this.transform(inputIterator, config)
    );
  }

  async *transform(
    generator: AsyncGenerator<PregelInputType>,
    config?: PregelOptions<Nn, Cc>
  ): AsyncGenerator<PregelOutputType> {
    for await (const chunk of this._transformStreamWithConfig(
      generator,
      this._transform,
      config
    )) {
      yield chunk;
    }
  }
}

async function executeTasks<RunOutput>(
  tasks: Array<() => Promise<RunOutput | Error | void>>,
  stepTimeout?: number,
  signal?: AbortSignal
): Promise<void> {
  if (stepTimeout && signal) {
    if ("any" in AbortSignal) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      signal = (AbortSignal as any).any([
        signal,
        AbortSignal.timeout(stepTimeout),
      ]);
    }
  } else if (stepTimeout) {
    signal = AbortSignal.timeout(stepTimeout);
  }

  // Abort if signal is aborted
  signal?.throwIfAborted();

  // Start all tasks
  const started = tasks.map((task) => task());

  // Wait for all tasks to settle
  // If any tasks fail, or signal is aborted, the promise will reject
  await Promise.all(
    signal
      ? [
          ...started,
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("Abort")));
          }),
        ]
      : started
  );
}

export function _shouldInterrupt<N extends PropertyKey, C extends PropertyKey>(
  checkpoint: ReadonlyCheckpoint,
  interruptNodes: All | Array<N>,
  snapshotChannels: Array<C>,
  tasks: Array<PregelExecutableTask<N, C>>
): boolean {
  const anySnapshotChannelUpdated = snapshotChannels.some(
    (chan) =>
      getChannelVersion(checkpoint, chan as string) >
      getVersionSeen(checkpoint, INTERRUPT, chan as string)
  );
  const anyTaskNodeInInterruptNodes = tasks.some((task) =>
    interruptNodes === "*"
      ? !task.config?.tags?.includes(TAG_HIDDEN)
      : interruptNodes.includes(task.name)
  );
  return anySnapshotChannelUpdated && anyTaskNodeInInterruptNodes;
}

export function _localRead<Cc extends StrRecord<string, BaseChannel>>(
  checkpoint: ReadonlyCheckpoint,
  channels: Cc,
  writes: Array<[keyof Cc, unknown]>,
  select: Array<keyof Cc> | keyof Cc,
  fresh: boolean = false
): Record<string, unknown> | unknown {
  if (fresh) {
    const newCheckpoint = createCheckpoint(checkpoint, channels, -1);
    // create a new copy of channels
    const newChannels = emptyChannels(channels, newCheckpoint);
    // Note: _applyWrites contains side effects
    _applyWrites(copyCheckpoint(newCheckpoint), newChannels, writes);
    return readChannels(newChannels, select);
  } else {
    return readChannels(channels, select);
  }
}

export function _localWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commit: (writes: [string, any][]) => void,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writes: [string, any][]
) {
  for (const [chan, value] of writes) {
    if (chan === TASKS) {
      if (!_isSend(value)) {
        throw new InvalidUpdateError(
          `Invalid packet type, expected SendProtocol, got ${JSON.stringify(
            value
          )}`
        );
      }
      if (!(value.node in processes)) {
        throw new InvalidUpdateError(
          `Invalid node name ${value.node} in packet`
        );
      }
    } else if (!(chan in channels)) {
      console.warn(`Skipping write for channel '${chan}' which has no readers`);
    }
  }
  commit(writes);
}

export function _applyWrites<Cc extends Record<string, BaseChannel>>(
  checkpoint: Checkpoint,
  channels: Cc,
  pendingWrites: Array<[keyof Cc, unknown]>
): void {
  if (checkpoint.pending_sends) {
    checkpoint.pending_sends = [];
  }
  const pendingWritesByChannel = {} as Record<keyof Cc, Array<unknown>>;
  // Group writes by channel
  for (const [chan, val] of pendingWrites) {
    if (chan === TASKS) {
      checkpoint.pending_sends.push({
        node: (val as Send).node,
        args: (val as Send).args,
      });
    } else {
      if (chan in pendingWritesByChannel) {
        pendingWritesByChannel[chan].push(val);
      } else {
        pendingWritesByChannel[chan] = [val];
      }
    }
  }

  // find the highest version of all channels
  let maxVersion = 0;
  if (Object.keys(checkpoint.channel_versions).length > 0) {
    maxVersion = Math.max(...Object.values(checkpoint.channel_versions));
  }

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const [chan, vals] of Object.entries(pendingWritesByChannel)) {
    if (chan in channels) {
      // side effect: update channels
      try {
        channels[chan].update(vals);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e.name === InvalidUpdateError.unminifiable_name) {
          throw new InvalidUpdateError(
            `Invalid update for channel ${chan}. Values: ${vals}\n\nError: ${e.message}`
          );
        }
      }

      // side effect: update checkpoint channel versions
      checkpoint.channel_versions[chan] = maxVersion + 1;

      updatedChannels.add(chan);
    } else {
      console.warn(`Skipping write for channel ${chan} which has no readers`);
    }
  }

  // Channels that weren't updated in this step are notified of a new step
  for (const chan in channels) {
    if (!updatedChannels.has(chan)) {
      // side effect: update channels
      channels[chan].update([]);
    }
  }
}

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  forExecution: false,
  extra: { step: number }
): [Checkpoint, Array<PregelTaskDescription>];

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  forExecution: true,
  extra: { step: number }
): [Checkpoint, Array<PregelExecutableTask<keyof Nn, keyof Cc>>];

export function _prepareNextTasks<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel>
>(
  checkpoint: ReadonlyCheckpoint,
  processes: Nn,
  channels: Cc,
  forExecution: boolean,
  extra: { step: number }
): [
  Checkpoint,
  PregelTaskDescription[] | PregelExecutableTask<keyof Nn, keyof Cc>[]
] {
  const newCheckpoint = copyCheckpoint(checkpoint);
  const tasks: Array<PregelExecutableTask<keyof Nn, keyof Cc>> = [];
  const taskDescriptions: Array<PregelTaskDescription> = [];

  for (const packet of checkpoint.pending_sends) {
    if (!_isSendInterface(packet)) {
      console.warn(
        `Ignoring invalid packet ${JSON.stringify(packet)} in pending sends.`
      );
      continue;
    }
    if (!(packet.node in processes)) {
      console.warn(
        `Ignoring unknown node name ${packet.node} in pending sends.`
      );
      continue;
    }
    if (forExecution) {
      const proc = processes[packet.node];
      const node = proc.getNode();
      if (node !== undefined) {
        const triggers = [TASKS];
        const metadata = {
          langgraph_step: extra.step,
          langgraph_node: packet.node,
          langgraph_triggers: triggers,
          langgraph_task_idx: tasks.length,
        };
        const writes: [keyof Cc, unknown][] = [];
        tasks.push({
          name: packet.node,
          input: packet.args,
          proc: node,
          writes,
          config: patchConfig(
            mergeConfigs(proc.config, processes[packet.node].config, {
              metadata,
            }),
            {
              runName: packet.node,
              // callbacks:
              configurable: {
                [CONFIG_KEY_SEND]: _localWrite.bind(
                  undefined,
                  (items: [keyof Cc, unknown][]) => writes.push(...items),
                  processes,
                  channels
                ),
                [CONFIG_KEY_READ]: _localRead.bind(
                  undefined,
                  checkpoint,
                  channels,
                  writes as Array<[string, unknown]>
                ),
              },
            }
          ),
        });
      }
    } else {
      taskDescriptions.push({
        name: packet.node,
        input: packet.args,
      });
    }
  }

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const [name, proc] of Object.entries<PregelNode>(processes)) {
    const hasUpdatedChannels = proc.triggers
      .filter((chan) => {
        try {
          readChannel(channels, chan, false);
          return true;
        } catch (e) {
          return false;
        }
      })
      .some(
        (chan) =>
          getChannelVersion(newCheckpoint, chan) >
          getVersionSeen(newCheckpoint, name, chan)
      );
    // If any of the channels read by this process were updated
    if (hasUpdatedChannels) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let val: any;

      // If all trigger channels subscribed by this process are not empty
      // then invoke the process with the values of all non-empty channels
      if (Array.isArray(proc.channels)) {
        let emptyChannels = 0;
        for (const chan of proc.channels) {
          try {
            val = readChannel(channels, chan, false);
            break;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            if (e.name === EmptyChannelError.unminifiable_name) {
              emptyChannels += 1;
              continue;
            } else {
              throw e;
            }
          }
        }

        if (emptyChannels === proc.channels.length) {
          continue;
        }
      } else if (typeof proc.channels === "object") {
        val = {};
        try {
          for (const [k, chan] of Object.entries(proc.channels)) {
            val[k] = readChannel(channels, chan, !proc.triggers.includes(chan));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          if (e.name === EmptyChannelError.unminifiable_name) {
            continue;
          } else {
            throw e;
          }
        }
      } else {
        throw new Error(
          `Invalid channels type, expected list or dict, got ${proc.channels}`
        );
      }

      // If the process has a mapper, apply it to the value
      if (proc.mapper !== undefined) {
        val = proc.mapper(val);
      }

      if (forExecution) {
        // Update seen versions
        if (!newCheckpoint.versions_seen[name]) {
          newCheckpoint.versions_seen[name] = {};
        }
        proc.triggers.forEach((chan: string) => {
          const version = newCheckpoint.channel_versions[chan];
          if (version !== undefined) {
            // side effect: updates newCheckpoint
            newCheckpoint.versions_seen[name][chan] = version;
          }
        });

        const node = proc.getNode();
        if (node !== undefined) {
          const metadata = {
            langgraph_step: extra.step,
            langgraph_node: name,
            langgraph_triggers: proc.triggers,
            langgraph_task_idx: tasks.length,
          };
          const writes: [keyof Cc, unknown][] = [];
          tasks.push({
            name,
            input: val,
            proc: node,
            writes,
            config: patchConfig(mergeConfigs(proc.config, { metadata }), {
              runName: name,
              configurable: {
                [CONFIG_KEY_SEND]: _localWrite.bind(
                  undefined,
                  (items: [keyof Cc, unknown][]) => writes.push(...items),
                  processes,
                  channels
                ),
                [CONFIG_KEY_READ]: _localRead.bind(
                  undefined,
                  checkpoint,
                  channels,
                  writes as Array<[string, unknown]>
                ),
              },
            }),
          });
        }
      } else {
        taskDescriptions.push({
          name,
          input: val,
        });
      }
    }
  }

  return [newCheckpoint, forExecution ? tasks : taskDescriptions];
}
