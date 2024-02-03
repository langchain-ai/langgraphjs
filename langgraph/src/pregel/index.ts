/* eslint-disable no-param-reassign */
import {
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableInterface,
  RunnableLike,
  _coerceToRunnable,
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
import { ChannelBatch, ChannelInvoke } from "./read.js";
import { validateGraph } from "./validate.js";
import { ReservedChannelsMap } from "./reserved.js";
import { mapInput, mapOutput } from "./io.js";
import { ChannelWrite } from "./write.js";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND } from "../constants.js";

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
  ChannelInvoke;

  static subscribeTo(
    channels: string[],
    options?: {
      key?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      when?: (arg: any) => boolean;
      tags?: string[];
    }
  ): ChannelInvoke;

  static subscribeTo(
    channels: string | string[],
    options?: {
      key?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      when?: (arg: any) => boolean;
      tags?: string[];
    }
  ): ChannelInvoke {
    const { key, when, tags } = options ?? {};
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

    return new ChannelInvoke({
      channels: channelMappingOrString,
      triggers,
      when,
      tags,
    });
  }

  static subscribeToEach(inbox: string, key?: string): ChannelBatch {
    return new ChannelBatch({
      channel: inbox,
      key,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static writeTo(...args: any[]): ChannelWrite {
    // const channelPairs: Array<[string, WriteValue<RunInput, RunOutput>]> =
    //   channels.map((c) => [c, undefined]);
    // return new ChannelWrite<RunInput, RunOutput>(channelPairs);
    const channelPairs: Array<[string, Runnable | undefined]> = [];

    if (args.length === 1 && typeof args[0] === "object") {
      // Handle the case where named arguments are passed as an object
      const additionalArgs = args[0];
      Object.entries(additionalArgs).forEach(([key, value]) => {
        channelPairs.push([key, _coerceWriteValue(value)]);
      });
    } else {
      args.forEach((channel) => {
        if (typeof channel === "string") {
          channelPairs.push([channel, undefined]);
        } else if (typeof channel === "object") {
          Object.entries(channel).forEach(([key, value]) => {
            channelPairs.push([key, _coerceWriteValue(value)]);
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

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  checkpointer?: BaseCheckpointSaver;

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

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  checkpointer?: BaseCheckpointSaver;

  stepTimeout?: number;

  interrupt: string[] = [];

  constructor(fields: PregelInterface) {
    super();

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
      checkpoint = this.checkpointer.get(config);
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

    const read = (chan: string) => _readChannel(channels, chan);

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
        this.checkpointer.put(config, checkpoint);
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
      this.checkpointer.put(config, checkpoint);
    }
  }

  async invoke(
    input: PregelInputType,
    config?: PregelOptions
  ): Promise<PregelOutputType> {
    if (!config?.outputKeys) {
      if (!config) {
        config = {};
      }
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

function _readChannel(
  channels: Record<string, BaseChannel>,
  chan: string
): unknown | null {
  try {
    return channels[chan].get();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    if (e.name === EmptyChannelError.name) {
      return null;
    }
    throw e;
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
    if (val === _readChannel(channels, chan)) {
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
  processes: Record<string, ChannelInvoke | ChannelBatch>,
  channels: Record<string, BaseChannel>
): Array<[RunnableInterface, unknown, string]> {
  const tasks: Array<[RunnableInterface, unknown, string]> = [];

  // Check if any processes should be run in next step
  // If so, prepare the values to be passed to them
  for (const name in processes) {
    if (Object.prototype.hasOwnProperty.call(processes, name)) {
      const proc = processes[name];
      let seen: Record<string, number> = checkpoint.versionsSeen[name];
      if (!seen) {
        checkpoint.versionsSeen[name] = {};
        seen = checkpoint.versionsSeen[name];
      }
      if ("triggers" in proc) {
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
              val[proc.channels] = _readChannel(channels, proc.channels);
            } else {
              for (const [k, chan] of Object.entries(proc.channels)) {
                val[k] = _readChannel(channels, chan);
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

            // skip if condition is not met
            if (proc.when === undefined || proc.when(val)) {
              tasks.push([proc, val, name]);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (error: any) {
            if (error.name === EmptyChannelError.name) {
              continue;
            } else {
              throw error;
            }
          }
        }
      } else if ("channel" in proc) {
        // If the channel read by this process was updated
        if (
          checkpoint.channelVersions[proc.channel] > (seen[proc.channel] ?? 0)
        ) {
          // Here we don't catch EmptyChannelError because the channel
          // must be initialized if the previous `if` condition is true
          let val = channels[proc.channel].get();
          if (proc.key !== undefined) {
            val = [{ [proc.key]: val }];
          }
          tasks.push([proc, val, name]);
          seen[proc.channel] = checkpoint.channelVersions[proc.channel];
        }
      }
    }
  }

  return tasks;
}
