/* eslint-disable no-param-reassign */
import {
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableInterface,
  RunnableLike,
  _coerceToRunnable,
  ensureConfig,
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
  copyCheckpoint,
  emptyCheckpoint,
} from "../checkpoint/base.js";
import { PregelNode } from "./read.js";
import { validateGraph, validateKeys } from "./validate.js";
import {
  mapInput,
  mapOutputUpdates,
  mapOutputValues,
  readChannel,
  readChannels,
} from "./io.js";
import { ChannelWrite, ChannelWriteEntry, PASSTHROUGH } from "./write.js";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND, INTERRUPT } from "../constants.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";
import { All, PregelExecutableTask, PregelTaskDescription } from "./types.js";
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
  streamMode?: StreamMode;

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
  streamMode?: StreamMode;
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
    const Nn extends StrRecord<string, PregelNode>,
    const Cc extends StrRecord<string, BaseChannel>
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

  streamMode: StreamMode = "values";

  streamChannels?: keyof Cc | Array<keyof Cc>;

  interruptAfter?: Array<keyof Nn> | All;

  interruptBefore?: Array<keyof Nn> | All;

  stepTimeout?: number;

  debug: boolean = false;

  checkpointer?: BaseCheckpointSaver;

  constructor(fields: PregelInterface<Nn, Cc>) {
    super(fields);

    // Initialize global async local storage instance for tracing
    initializeAsyncLocalStorageSingleton();
    this.nodes = fields.nodes;
    this.channels = fields.channels;
    this.autoValidate = fields.autoValidate ?? this.autoValidate;
    this.streamMode = fields.streamMode ?? this.streamMode;
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

  _defaults(config: PregelOptions<Nn, Cc>): [
    boolean, // debug
    StreamMode, // stream mode
    keyof Cc | Array<keyof Cc>, // input keys
    keyof Cc | Array<keyof Cc>, // output keys
    RunnableConfig, // config without pregel keys
    All | Array<keyof Nn> | undefined, // interrupt before
    All | Array<keyof Nn> | undefined // interrupt after,
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

    let defaultInterruptBefore;
    if (
      (Array.isArray(interruptBefore) && interruptBefore.length > 0) ||
      interruptBefore === "*"
    ) {
      defaultInterruptBefore = interruptBefore;
    } else {
      defaultInterruptBefore = this.interruptBefore;
    }

    let defaultInterruptAfter;
    if (
      (Array.isArray(interruptAfter) && interruptAfter.length > 0) ||
      interruptAfter === "*"
    ) {
      defaultInterruptAfter = interruptAfter;
    } else {
      defaultInterruptAfter = this.interruptAfter;
    }

    let defaultStreamMode: StreamMode;
    if (streamMode !== undefined) {
      defaultStreamMode = streamMode;
    } else {
      defaultStreamMode = this.streamMode;
    }

    if (
      config.configurable !== undefined &&
      config.configurable[CONFIG_KEY_READ] !== undefined
    ) {
      defaultStreamMode = "values";
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
    // assign defaults
    const [
      debug,
      streamMode,
      inputKeys,
      outputKeys,
      restConfig,
      // interruptBefore,
      // interruptAfter,
    ] = this._defaults(config);
    // copy nodes to ignore mutations during execution
    const processes = { ...this.nodes };
    // get checkpoint, or create an empty one
    let checkpoint: Checkpoint | undefined;
    if (this.checkpointer) {
      checkpoint = await this.checkpointer.get(config);
    }
    checkpoint = checkpoint ?? emptyCheckpoint();

    // create channels from checkpoint
    const channels = emptyChannels(this.channels, checkpoint);
    // map inputs to channel updates

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputPendingWrites: Array<[keyof Cc, any]> = [];
    for await (const c of input) {
      for (const value of mapInput(inputKeys, c)) {
        inputPendingWrites.push(value);
      }
    }

    _applyWrites(checkpoint, channels, inputPendingWrites);

    // TODO checkpoint inputs

    // Similarly to Bulk Synchronous Parallel / Pregel model
    // computation proceeds in steps, while there are channel updates
    // channel updates from step N are only visible in step N+1
    // channels are guaranteed to be immutable for the duration of the step,
    // with channel updates applied only at the transition between steps
    const recursionLimit = config.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    for (let step = 0; step < recursionLimit + 1; step += 1) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [nextCheckpoint, nextTasks] = _prepareNextTasks(
        checkpoint,
        processes,
        channels,
        true
      );

      if (debug) {
        console.log(nextTasks);
      }

      // Reassign nextCheckpoint to checkpoint because the subsequent implementation
      // relies on side effects applied to checkpoint. Example: _applyWrites().
      checkpoint = nextCheckpoint as Checkpoint;

      // if no more tasks, we're done
      if (nextTasks.length === 0) {
        break;
      } else if (step === config.recursionLimit) {
        throw new GraphRecursionError(
          `Recursion limit of ${config.recursionLimit} reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.`
        );
      }

      // TODO interrupt before

      // A copy of the checkpoint is created because `checkpoint` is defined with `let`.
      // `checkpoint` can be mutated during loop execution and when used in a function,
      // may cause unintended consequences.
      const checkpointCopy = copyCheckpoint(checkpoint);

      const tasksWithConfig: Array<
        [RunnableInterface, unknown, RunnableConfig]
      > = nextTasks.map((task) => [
        task.proc,
        task.input,
        patchConfig(restConfig, {
          callbacks: runManager?.getChild(`graph:step:${step}`),
          runName: task.name,
          configurable: {
            ...config.configurable,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            [CONFIG_KEY_SEND]: (items: [string, any][]) =>
              task.writes.push(...items),
            [CONFIG_KEY_READ]: _localRead.bind(
              undefined,
              checkpointCopy,
              channels,
              task.writes
            ),
          },
        }),
      ]);

      // execute tasks, and wait for one to fail or all to finish.
      // each task is independent from all other concurrent tasks
      const tasks = tasksWithConfig.map(
        ([proc, input, updatedConfig]) =>
          () =>
            proc.invoke(input, updatedConfig)
      );

      await executeTasks(tasks, this.stepTimeout);

      // combine pending writes from all tasks
      const pendingWrites: Array<[string, unknown]> = [];
      for (const task of nextTasks) {
        pendingWrites.push(...task.writes);
      }

      // apply writes to channels
      _applyWrites(checkpoint, channels, pendingWrites);

      // yield current value and checkpoint view
      if (streamMode === "values") {
        yield* mapOutputValues(outputKeys, pendingWrites, channels);
      } else if (streamMode === "updates") {
        yield* mapOutputUpdates(outputKeys, nextTasks);
      }

      // save end of step checkpoint
      if (this.checkpointer) {
        checkpoint = await createCheckpoint(checkpoint, channels);
        await this.checkpointer.put(config, checkpoint);
        // TODO save in background
      }

      // TODO interrupt after
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

function timeout(ms: number): Promise<void> {
  return new Promise((reject) => {
    setTimeout(reject, ms);
  });
}

async function executeTasks<RunOutput>(
  tasks: Array<() => Promise<RunOutput | Error | void>>,
  stepTimeout?: number
): Promise<void> {
  // Wrap each task in a Promise that respects the step timeout
  const wrappedTasks = tasks.map((task) =>
    stepTimeout
      ? Promise.race([
          task(),
          stepTimeout ? timeout(stepTimeout) : Promise.resolve(),
        ])
      : task()
  );

  // Wait for all tasks to settle
  const results = await Promise.allSettled(wrappedTasks);

  // Process the results
  for (const result of results) {
    if (result.status === "rejected") {
      // If any task failed, cancel all pending tasks and throw the error
      throw result.reason;
    }
  }
}

export function _shouldInterrupt(
  checkpoint: Checkpoint,
  interruptNodes: Array<string>,
  snapshotChannels: Array<string>,
  tasks: Array<PregelExecutableTask>
): boolean {
  const seen = checkpoint.versionsSeen[INTERRUPT];
  const anySnapshotChannelUpdated = snapshotChannels.some(
    (chan) => checkpoint.channelVersions[chan] > seen[chan]
  );
  const anyTaskNodeInInterruptNodes = tasks.some((task) =>
    interruptNodes.includes(task.name)
  );
  return anySnapshotChannelUpdated && anyTaskNodeInInterruptNodes;
}

export function _localRead(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writes: Array<[string, any]>,
  select: Array<string> | string,
  fresh: boolean = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | any {
  if (fresh) {
    const newCheckpoint = createCheckpoint(checkpoint, channels);

    // create a new copy of channels
    const newChannels = Object.entries(channels).reduce(
      (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        acc: Record<string, any>,
        [channelName, channel]: [string, BaseChannel]
      ) => {
        acc[channelName] = channel.fromCheckpoint(
          newCheckpoint.channelValues[channelName]
        );
        return acc;
      },
      {}
    );

    // Note: _applyWrites contains side effects
    _applyWrites(copyCheckpoint(newCheckpoint), newChannels, writes);
    return readChannels(newChannels, select);
  } else {
    return readChannels(channels, select);
  }
}

export function _applyWrites<Cc extends Record<string, BaseChannel>>(
  checkpoint: Checkpoint,
  channels: Cc,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingWrites: Array<[keyof Cc, any]>
): void {
  const pendingWritesByChannel = {} as Record<
    keyof Cc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array<any>
  >;
  // Group writes by channel
  for (const [chan, val] of pendingWrites) {
    if (chan in pendingWritesByChannel) {
      pendingWritesByChannel[chan].push(val);
    } else {
      pendingWritesByChannel[chan] = [val];
    }
  }

  // find the highest version of all channels
  let maxVersion = 0;
  if (Object.keys(checkpoint.channelVersions).length > 0) {
    maxVersion = Math.max(...Object.values(checkpoint.channelVersions));
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
        if (e.name === InvalidUpdateError.name) {
          throw new InvalidUpdateError(
            `Invalid update for channel ${chan}. Values: ${vals}`
          );
        }
      }

      // side effect: update checkpoint channel versions
      checkpoint.channelVersions[chan] = maxVersion + 1;

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

export function _prepareNextTasks(
  checkpoint: Checkpoint,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
  forExecution: false
): [Checkpoint, Array<PregelTaskDescription>];

export function _prepareNextTasks(
  checkpoint: Checkpoint,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
  forExecution: true
): [Checkpoint, Array<PregelExecutableTask>];

export function _prepareNextTasks(
  checkpoint: Checkpoint,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>,
  forExecution: boolean
): [Checkpoint, Array<PregelTaskDescription> | Array<PregelExecutableTask>] {
  const newCheckpoint = copyCheckpoint(checkpoint);
  const tasks: Array<PregelExecutableTask> = [];
  const taskDescriptions: Array<PregelTaskDescription> = [];

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const [name, proc] of Object.entries<PregelNode>(processes)) {
    let seen = newCheckpoint.versionsSeen[name];
    if (!seen) {
      newCheckpoint.versionsSeen[name] = {};
      seen = newCheckpoint.versionsSeen[name];
    }

    // If any of the channels read by this process were updated
    if (
      proc.triggers
        .filter(
          (chan) =>
            readChannel(channels, chan, true, true) !== EmptyChannelError
        )
        .some((chan) => newCheckpoint.channelVersions[chan] > (seen[chan] ?? 0))
    ) {
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
            if (e.name === EmptyChannelError.name) {
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
          if (e.name === EmptyChannelError.name) {
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
        proc.triggers.forEach((chan: string) => {
          const version = newCheckpoint.channelVersions[chan];
          if (version !== undefined) {
            // side effect: updates newCheckpoint
            seen[chan] = version;
          }
        });

        const node = proc.getNode();
        if (node !== undefined) {
          tasks.push({
            name,
            input: val,
            proc: node,
            writes: [],
            config: proc.config,
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
