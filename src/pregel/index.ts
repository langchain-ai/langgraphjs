import {
  Runnable,
  RunnableConfig,
  RunnableInterface,
  _coerceToRunnable
} from "@langchain/core/runnables";
import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  BaseChannel,
  ChannelsManager,
  EmptyChannelError,
  createCheckpoint
} from "../channels/base.js";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  emptyCheckpoint
} from "../checkpoint/base.js";
import { ChannelBatch, ChannelInvoke } from "./read.js";
import { validateGraph } from "./validate.js";
import { ReservedChannels } from "./reserved.js";
import { mapInput, mapOutput } from "./io.js";
import { ChannelWrite } from "./write.js";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND } from "../constants.js";

type WriteValue<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> =
  | Runnable<RunInput, RunOutput>
  | ((input: RunInput) => RunOutput)
  | ((input: RunInput) => Promise<RunOutput>)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | any;

function _coerceWriteValue<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(value: WriteValue): Runnable<RunInput, RunOutput> {
  if (!Runnable.isRunnable(value) && typeof value !== "function") {
    return _coerceToRunnable<RunInput, RunOutput>(() => value);
  }
  return _coerceToRunnable<RunInput, RunOutput>(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export class Channel {
  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >(
    channels: string,
    key?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ChannelInvoke<RunInput, RunOutput>;

  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >(
    channels: string[],
    key?: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): ChannelInvoke<RunInput, RunOutput>;

  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >(
    channels: string | string[],
    key?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): ChannelInvoke<RunInput, RunOutput> {
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
      when
    });
  }

  static subscribeToEach<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >(inbox: string, key?: string): ChannelBatch<RunInput, RunOutput> {
    return new ChannelBatch<RunInput, RunOutput>({
      channel: inbox,
      key
    });
  }

  static writeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  >(...args: any[]): ChannelWrite<RunInput, RunOutput> {
    // const channelPairs: Array<[string, WriteValue<RunInput, RunOutput>]> =
    //   channels.map((c) => [c, undefined]);
    // return new ChannelWrite<RunInput, RunOutput>(channelPairs);
    const channelPairs: Array<
      [string, Runnable<RunInput, RunOutput> | undefined]
    > = [];

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

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  saver?: BaseCheckpointSaver;

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
  // Because Pregel extends `Runnable`.
  lc_namespace = ["langgraph", "pregel"];

  channels: Record<string, BaseChannel> = {};

  output: string | Array<string> = "output";

  input: string | Array<string> = "input";

  hidden: Array<string> = [];

  debug: boolean = false;

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;

  constructor(fields: PregelInterface) {
    super();

    this.channels = fields.channels ?? this.channels;
    this.output = fields.output ?? this.output;
    this.input = fields.input ?? this.input;
    this.hidden = fields.hidden ?? this.hidden;
    this.debug = fields.debug ?? this.debug;
    this.nodes = fields.nodes;
    this.saver = fields.saver;
    this.stepTimeout = fields.stepTimeout;

    // Bind the method to the instance
    this._transform = this._transform.bind(this);

    validateGraph({
      nodes: this.nodes,
      channels: this.channels,
      output: this.output,
      input: this.input,
      hidden: this.hidden
    });
  }

  async *_transform(
    input: AsyncGenerator<PregelInputType>,
    runManager?: CallbackManagerForChainRun,
    config?: RunnableConfig & Partial<Record<string, unknown>>
  ): AsyncGenerator<PregelOutputType> {
    const newConfig: RunnableConfig & Partial<Record<string, unknown>> =
      config?.recursionLimit === undefined
        ? {
            recursionLimit: 25, // Default
            ...config
          }
        : config;

    if (
      newConfig.recursionLimit === undefined ||
      newConfig.recursionLimit < 1
    ) {
      throw new Error("recursionLimit must be at least 1");
    }

    // assign defaults
    let newOutputs: string | Array<string> = [];
    if (
      Array.isArray(newConfig.output) ||
      typeof newConfig.output === "string"
    ) {
      newOutputs = newConfig.output;
    }
    if (Array.isArray(newOutputs)) {
      for (const chan in this.channels) {
        if (!this.hidden.includes(chan)) {
          newOutputs.push(chan);
        }
      }
    }
    // copy nodes to ignore mutations during execution
    const processes = { ...this.nodes };
    // get checkpoint from saver, or create an empty one
    let checkpoint: Checkpoint | undefined;
    if (this.saver) {
      checkpoint = this.saver.get(newConfig);
    }
    checkpoint = checkpoint ?? emptyCheckpoint();

    // create channels from checkpoint
    const manager = new ChannelsManager(this.channels, checkpoint).manage();
    for await (const channels of manager) {
      // map inputs to channel updates
      const thisInput = this.input;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingWritesDeque: Array<[string, any]> = [];
      for await (const c of input) {
        for (const value of mapInput(thisInput, c)) {
          pendingWritesDeque.push(value);
        }
      }

      _applyWrites(checkpoint, channels, pendingWritesDeque, newConfig, 0);

      const read = (chan: string) => _readChannel(channels, chan);

      // Similarly to Bulk Synchronous Parallel / Pregel model
      // computation proceeds in steps, while there are channel updates
      // channel updates from step N are only visible in step N+1
      // channels are guaranteed to be immutable for the duration of the step,
      // with channel updates applied only at the transition between steps
      for (let step = 0; step < (newConfig.recursionLimit ?? 0); step += 1) {
        const nextTasks = _prepareNextTasks(checkpoint, processes, channels);
        // if no more tasks, we're done
        if (nextTasks.length === 0) {
          break;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pendingWrites: Array<[string, any]> = [];

        const tasksWithConfig: Array<
          [RunnableInterface, unknown, RunnableConfig]
        > = nextTasks.map(([proc, input, name]) => {
          if (
            !("_patchConfig" in proc) ||
            typeof proc._patchConfig !== "function"
          ) {
            throw new Error("Runnable must implement _patchConfig");
          }
          return [
            proc,
            input,
            proc._patchConfig(
              {
                ...newConfig,
                runName: name,
                configurable: {
                  ...newConfig.configurable,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  [CONFIG_KEY_SEND]: (items: [string, any][]) =>
                    pendingWrites.push(...items),
                  [CONFIG_KEY_READ]: read
                }
              },
              runManager?.getChild(`graph:step:${step}`)
            )
          ];
        });

        // execute tasks, and wait for one to fail or all to finish.
        // each task is independent from all other concurrent tasks
        const tasks = tasksWithConfig.map(
          ([proc, input, updatedConfig]) =>
            async () =>
              proc.invoke(input, updatedConfig)
        );

        await executeTasks(tasks, this.stepTimeout);

        // apply writes to channels
        _applyWrites(checkpoint, channels, pendingWrites, newConfig, step + 1);

        // yield current value and checkpoint view
        const stepOutput = mapOutput(newOutputs, pendingWrites, channels);

        if (stepOutput) {
          yield stepOutput;

          // we can detect updates when output is multiple channels (ie. object)
          if (typeof newOutputs !== "string") {
            _applyWritesFromView(checkpoint, channels, stepOutput);
          }
        }

        // save end of step checkpoint
        if (this.saver && this.saver.at === CheckpointAt.END_OF_STEP) {
          checkpoint = await createCheckpoint(checkpoint, channels);
          this.saver.put(newConfig, checkpoint);
        }
      }

      // save end of run checkpoint
      if (this.saver && this.saver.at === CheckpointAt.END_OF_RUN) {
        checkpoint = await createCheckpoint(checkpoint, channels);
        this.saver.put(newConfig, checkpoint);
      }
    }
  }

  async invoke(
    input: PregelInputType,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): Promise<PregelOutputType> {
    let newOutput = output;
    if (newOutput === undefined) {
      if (config && "output" in config) {
        newOutput = config.output as string | string[] | undefined;
      } else {
        newOutput = this.output;
      }
    }

    let latest: PregelOutputType | undefined;
    for await (const chunk of await this.stream(input, config, newOutput)) {
      latest = chunk;
    }
    if (!latest) {
      return undefined as PregelOutputType;
    }
    return latest;
  }

  async stream(
    input: PregelInputType,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): Promise<IterableReadableStream<PregelOutputType>> {
    const inputIterator: AsyncGenerator<PregelInputType> = (async function* () {
      yield input;
    })();
    return IterableReadableStream.fromAsyncGenerator(
      this.transform(inputIterator, { ...config, output })
    );
  }

  async *transform(
    generator: AsyncGenerator<PregelInputType>,
    config?: RunnableConfig & Partial<Record<string, unknown>>
  ): AsyncGenerator<PregelOutputType> {
    for await (const chunk of this._transformStreamWithConfig<
      PregelInputType,
      PregelOutputType
    >(generator, this._transform, config)) {
      yield chunk;
    }
  }
}

async function executeTasks<RunOutput>(
  tasks: Array<() => Promise<RunOutput | Error | void>>,
  stepTimeout?: number
): Promise<void> {
  // Wrap each task in a Promise that respects the step timeout
  const wrappedTasks = tasks.map(
    (task) =>
      new Promise((resolve, reject) => {
        let timeout: NodeJS.Timeout;
        if (stepTimeout) {
          timeout = setTimeout(() => {
            reject(new Error(`Timed out at step ${stepTimeout}`));
          }, stepTimeout);
        }

        task().then(resolve, (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      })
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
    for (const c in ReservedChannels) {
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
  pendingWritesByChannel[ReservedChannels.isLastStep] = [
    forStep + 1 === config.recursionLimit
  ];

  const updatedChannels: Set<string> = new Set();
  // Apply writes to channels
  for (const chan in pendingWritesByChannel) {
    if (chan in pendingWritesByChannel) {
      const vals = pendingWritesByChannel[chan];
      if (chan in channels) {
        channels[chan].update(vals);

        if (checkpoint.channelVersions[chan] === undefined) {
          // eslint-disable-next-line no-param-reassign
          checkpoint.channelVersions[chan] = 1;
        } else {
          // eslint-disable-next-line no-param-reassign
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, any>
) {
  for (const [chan, value] of Object.entries(values)) {
    if (value === channels[chan].get()) {
      continue;
    }
    if (channels[chan].lc_graph_name !== "LastValue") {
      throw new Error(
        `Can't modify channel ${chan} of type ${channels[chan].lc_graph_name}`
      );
    }
    // eslint-disable-next-line no-param-reassign
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
        // eslint-disable-next-line no-param-reassign
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
        if (checkpoint.channelVersions[proc.channel] > seen[proc.channel]) {
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
