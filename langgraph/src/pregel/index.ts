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
  EmptyChannelError,
  createCheckpoint,
  emptyChannels,
} from "../channels/base.js";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  emptyCheckpoint,
} from "../checkpoint/base.js";
import { PregelNode } from "./read.js";
import { validateGraph } from "./validate.js";
import { ReservedChannelsMap } from "./reserved.js";
import { mapInput, mapOutput, readChannel } from "./io.js";
import { ChannelWrite, ChannelWriteEntry } from "./write.js";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND } from "../constants.js";
import { initializeAsyncLocalStorageSingleton } from "../setup/async_local_storage.js";

const DEFAULT_RECURSION_LIMIT = 25;

export class GraphRecursionError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphRecursionError";
  }
}

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;

function _coerceWriteValue(value: WriteValue): Runnable {
  if (!Runnable.isRunnable(value) && typeof value !== "function") {
    return _coerceToRunnable(() => value);
  }
  return _coerceToRunnable(value as RunnableLike);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export class Channel {
  static subscribeTo(
    channels: string,
    options?: {
      key?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      when?: (arg: any) => boolean;
      tags?: string[];
    }
  ): // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PregelNode;

  static subscribeTo(
    channels: string[],
    options?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      when?: (arg: any) => boolean;
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

    let channelMappingOrString: string | Record<string, string>;

    if (isString(channels)) {
      if (key) {
        channelMappingOrString = { [key]: channels };
      } else {
        channelMappingOrString = channels;
      }
    } else {
      channelMappingOrString = Object.fromEntries(
        channels.map((chan) => [chan, chan])
      );
    }

    const triggers: string[] = Array.isArray(channels) ? channels : [channels];

    return new PregelNode({
      channels: channelMappingOrString,
      triggers,
      tags,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static writeTo(...args: any[]): ChannelWrite {
    const channelPairs: Array<ChannelWriteEntry> = [];

    if (args.length === 1 && typeof args[0] === "object") {
      // Handle the case where named arguments are passed as an object
      const additionalArgs = args[0];
      Object.entries(additionalArgs).forEach(([key, value]) => {
        channelPairs.push({
          channel: key,
          value: _coerceWriteValue(value),
          skipNone: false,
        });
      });
    } else {
      args.forEach((channel) => {
        if (typeof channel === "string") {
          channelPairs.push({ channel, value: undefined, skipNone: false });
        } else if (typeof channel === "object") {
          Object.entries(channel).forEach(([key, value]) => {
            channelPairs.push({
              channel: key,
              value: _coerceWriteValue(value),
              skipNone: false,
            });
          });
        }
      });
    }

    return new ChannelWrite(channelPairs);
  }
}

export interface PregelInterface {
  /**
   * @default {}
   */
  channels?: Record<string, BaseChannel>;
  /**
   * @default "output"
   */
  output?: string | Array<string>;
  /**
   * @default "input"
   */
  input?: string | Array<string>;
  /**
   * @default []
   */
  hidden?: Array<string>;
  /**
   * @default false
   */
  debug?: boolean;
  /**
   * @default []
   */
  interrupt?: string[];

  nodes: Record<string, PregelNode>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpointer?: BaseCheckpointSaver<any>;

  stepTimeout?: number;
}

export interface PregelOptions extends RunnableConfig {
  outputKeys?: string | string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelInputType = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PregelOutputType = any;

export class Pregel
  extends Runnable<PregelInputType, PregelOutputType, PregelOptions>
  implements PregelInterface
{
  static lc_name() {
    return "LangGraph";
  }

  // Because Pregel extends `Runnable`.
  lc_namespace = ["langgraph", "pregel"];

  channels: Record<string, BaseChannel> = {};

  output: string | Array<string> = "output";

  input: string | Array<string> = "input";

  hidden: Array<string> = [];

  debug: boolean = false;

  nodes: Record<string, PregelNode>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpointer?: BaseCheckpointSaver<any>;

  stepTimeout?: number;

  interrupt: string[] = [];

  constructor(fields: PregelInterface) {
    super(fields);

    // Initialize global async local storage instance for tracing
    initializeAsyncLocalStorageSingleton();
    this.channels = fields.channels ?? this.channels;
    this.output = fields.output ?? this.output;
    this.input = fields.input ?? this.input;
    this.hidden = fields.hidden ?? this.hidden;
    this.debug = fields.debug ?? this.debug;
    this.nodes = fields.nodes;
    this.checkpointer = fields.checkpointer;
    this.stepTimeout = fields.stepTimeout;
    this.interrupt = fields.interrupt ?? this.interrupt;

    // Bind the method to the instance
    this._transform = this._transform.bind(this);

    validateGraph({
      nodes: this.nodes,
      channels: this.channels,
      output: this.output,
      input: this.input,
      hidden: this.hidden,
      interrupt: this.interrupt,
    });
  }

  async *_transform(
    input: AsyncGenerator<PregelInputType>,
    runManager?: CallbackManagerForChainRun,
    config: RunnableConfig & Partial<Record<string, unknown>> = {}
  ): AsyncGenerator<PregelOutputType> {
    // assign defaults
    let outputKeys: string | Array<string> = [];
    if (
      Array.isArray(config.outputKeys) ||
      typeof config.outputKeys === "string"
    ) {
      outputKeys = config.outputKeys;
    } else {
      for (const chan in this.channels) {
        if (!this.hidden.includes(chan)) {
          outputKeys.push(chan);
        }
      }
    }
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
    const thisInput = this.input;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputPendingWrites: Array<[string, any]> = [];
    for await (const c of input) {
      for (const value of mapInput(thisInput, c)) {
        inputPendingWrites.push(value);
      }
    }

    _applyWrites(checkpoint, channels, inputPendingWrites, config, 0);

    const read = (chan: string) => readChannel(channels, chan);

    // Similarly to Bulk Synchronous Parallel / Pregel model
    // computation proceeds in steps, while there are channel updates
    // channel updates from step N are only visible in step N+1
    // channels are guaranteed to be immutable for the duration of the step,
    // with channel updates applied only at the transition between steps
    const recursionLimit = config.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    for (let step = 0; step < recursionLimit + 1; step += 1) {
      const nextTasks = _prepareNextTasks(checkpoint, processes, channels);
      // if no more tasks, we're done
      if (nextTasks.length === 0) {
        break;
      } else if (step === config.recursionLimit) {
        throw new GraphRecursionError(
          `Recursion limit of ${config.recursionLimit} reached without hitting a stop condition. You can increase the limit by setting the "recursionLimit" config key.`
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingWrites: Array<[string, any]> = [];

      const tasksWithConfig: Array<
        [RunnableInterface, unknown, RunnableConfig]
      > = nextTasks.map(([proc, input, name]) => [
        proc,
        input,
        patchConfig(config, {
          callbacks: runManager?.getChild(`graph:step:${step}`),
          runName: name,
          configurable: {
            ...config.configurable,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            [CONFIG_KEY_SEND]: (items: [string, any][]) =>
              pendingWrites.push(...items),
            [CONFIG_KEY_READ]: read,
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

      // apply writes to channels
      _applyWrites(checkpoint, channels, pendingWrites, config, step + 1);

      // yield current value and checkpoint view
      const stepOutput = mapOutput(outputKeys, pendingWrites, channels);

      if (stepOutput) {
        yield stepOutput;

        if (typeof outputKeys !== "string") {
          _applyWritesFromView(checkpoint, channels, stepOutput);
        }
      }

      // save end of step checkpoint
      if (
        this.checkpointer &&
        this.checkpointer.at === CheckpointAt.END_OF_STEP
      ) {
        checkpoint = await createCheckpoint(checkpoint, channels);
        await this.checkpointer.put(config, checkpoint);
      }

      // interrupt if any channel written to is in interrupt list
      if (
        pendingWrites.some(([chan]) => this.interrupt?.some((i) => i === chan))
      ) {
        break;
      }
    }

    // save end of run checkpoint
    if (this.checkpointer && this.checkpointer.at === CheckpointAt.END_OF_RUN) {
      checkpoint = await createCheckpoint(checkpoint, channels);
      await this.checkpointer.put(config, checkpoint);
    }
  }

  async invoke(
    input: PregelInputType,
    options?: PregelOptions
  ): Promise<PregelOutputType> {
    const config = ensureConfig(options);
    if (!config?.outputKeys) {
      config.outputKeys = this.output;
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
    config?: PregelOptions
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
    config?: PregelOptions
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

function _applyWrites(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingWrites: Array<[string, any]>,
  config: RunnableConfig,
  forStep: number
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingWritesByChannel: Record<string, Array<any>> = {};
  // Group writes by channel
  for (const [chan, val] of pendingWrites) {
    for (const c in ReservedChannelsMap) {
      if (chan === c) {
        throw new Error(`Can't write to reserved channel ${chan}`);
      }
    }
    if (chan in pendingWritesByChannel) {
      pendingWritesByChannel[chan].push(val);
    } else {
      pendingWritesByChannel[chan] = [val];
    }
  }

  // Update reserved channels
  pendingWritesByChannel[ReservedChannelsMap.isLastStep] = [
    forStep + 1 === config.recursionLimit,
  ];

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const chan in pendingWritesByChannel) {
    if (chan in pendingWritesByChannel) {
      const vals = pendingWritesByChannel[chan];
      if (chan in channels) {
        channels[chan].update(vals);

        if (checkpoint.channelVersions[chan] === undefined) {
          checkpoint.channelVersions[chan] = 1;
        } else {
          checkpoint.channelVersions[chan] += 1;
        }

        updatedChannels.add(chan);
      } else {
        console.warn(`Skipping write for channel ${chan} which has no readers`);
      }
    }
  }
  // Channels that weren't updated in this step are notified of a new step
  for (const chan in channels) {
    if (!updatedChannels.has(chan)) {
      channels[chan].update([]);
    }
  }
}

function _applyWritesFromView(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel>,
  values: Record<string, unknown>
) {
  for (const [chan, val] of Object.entries(values)) {
    if (val === readChannel(channels, chan)) {
      continue;
    }

    if (channels[chan].lc_graph_name === "LastValue") {
      throw new Error(`Can't modify channel ${chan} with LastValue`);
    }
    checkpoint.channelVersions[chan] += 1;
    channels[chan].update([values[chan]]);
  }
}

function _prepareNextTasks(
  checkpoint: Checkpoint,
  processes: Record<string, PregelNode>,
  channels: Record<string, BaseChannel>
): Array<[RunnableInterface, unknown, string]> {
  const tasks: Array<[RunnableInterface, unknown, string]> = [];

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const [name, proc] of Object.entries<PregelNode>(processes)) {
    let seen: Record<string, number> = checkpoint.versionsSeen[name];
    if (!seen) {
      checkpoint.versionsSeen[name] = {};
      seen = checkpoint.versionsSeen[name];
    }

    // If any of the channels read by this process were updated
    if (
      proc.triggers.some(
        (chan) => checkpoint.channelVersions[chan] > (seen[chan] ?? 0)
      )
    ) {
      // If all channels subscribed by this process have been initialized
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let val: Record<string, any> = {};
        if (typeof proc.channels === "string") {
          val[proc.channels] = readChannel(channels, proc.channels);
        } else {
          for (const [k, chan] of Object.entries(proc.channels)) {
            val[k] = readChannel(channels, chan);
          }
        }

        // Processes that subscribe to a single keyless channel get
        // the value directly, instead of a dict
        if (typeof proc.channels === "string") {
          val = val[proc.channels];
        } else if (
          Object.keys(proc.channels).length === 1 &&
          proc.channels[Object.keys(proc.channels)[0]] === undefined
        ) {
          val = val[Object.keys(proc.channels)[0]];
        }

        // Update seen versions
        proc.triggers.forEach((chan: string) => {
          const version = checkpoint.channelVersions[chan];
          if (version !== undefined) {
            seen[chan] = version;
          }
        });

        tasks.push([proc, val, name]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        if (error.name === EmptyChannelError.name) {
          continue;
        } else {
          throw error;
        }
      }
    }
  }

  return tasks;
}
