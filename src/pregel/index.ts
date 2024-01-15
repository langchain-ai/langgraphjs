import {
  Runnable,
  RunnableBatchOptions,
  RunnableConfig,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import {
  CallbackManager,
  CallbackManagerForChainRun,
} from "@langchain/core/callbacks/manager";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  BaseChannel,
  ChannelsManager,
  EmptyChannelError,
  createCheckpoint,
} from "../channels/base.js";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointAt,
  emptyCheckpoint,
} from "../checkpoint/base.js";
import { ChannelBatch, ChannelInvoke } from "./read.js";
import { validateGraph } from "./validate.js";
import { ReservedChannels } from "./reserved.js";
import { mapInput, mapOutput } from "./io.js";
import { ChannelWrite } from "./write.js";
import { CONFIG_KEY_READ, CONFIG_KEY_SEND, MISSING_KEY } from "../constants.js";

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

    const channelMapping: Record<string, string> = isString(channels)
      ? { [key ?? MISSING_KEY]: channels }
      : Object.fromEntries(channels.map((chan) => [chan, chan]));
    const triggers: string[] = Array.isArray(channels) ? channels : [channels];

    return new ChannelInvoke({
      channels: channelMapping,
      triggers,
      when,
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
      key,
    });
  }

  static writeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >(
    channels: string[] | string,
    values?: { [key: string]: WriteValue }
  ): ChannelWrite<RunInput, RunOutput> {
    const channelWrites: Array<
      [string, Runnable<RunInput, RunOutput> | undefined]
    > = Array.isArray(channels)
      ? channels.map((c) => [c, undefined])
      : [[channels, undefined]];

    const newValues = values ?? {};
    Object.entries(newValues).forEach(([k, v]) => {
      channelWrites.push([k, _coerceWriteValue<RunInput, RunOutput>(v)]);
    });

    return new ChannelWrite<RunInput, RunOutput>(channelWrites);
  }
}

export interface PregelInterface<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> {
  /**
   * @default {}
   */
  channels?: Record<string, BaseChannel<RunOutput>>;
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

  nodes: Record<
    string,
    ChannelInvoke<RunInput, RunOutput> | ChannelBatch<RunInput, RunOutput>
  >;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;
}

export class Pregel<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput = any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput = any
  >
  extends Runnable<RunInput, RunOutput>
  implements PregelInterface<RunInput, RunOutput>
{
  // Because Pregel extends `Runnable`.
  lc_namespace = ["langgraph", "pregel"];

  channels: Record<string, BaseChannel<RunOutput>> = {};

  output: string | Array<string> = "output";

  input: string | Array<string> = "input";

  hidden: Array<string> = [];

  debug: boolean = false;

  nodes: Record<
    string,
    ChannelInvoke<RunInput, RunOutput> | ChannelBatch<RunInput, RunOutput>
  >;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;

  constructor(fields: PregelInterface<RunInput, RunOutput>) {
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

    validateGraph<RunInput, RunOutput>({
      nodes: this.nodes,
      channels: this.channels,
      output: this.output,
      input: this.input,
    });
  }

  async batch(
    inputs: RunInput[],
    options?:
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)[],
    batchOptions?: RunnableBatchOptions & { returnExceptions: true }
  ): Promise<(RunOutput | Error)[]>;

  async batch(
    inputs: RunInput[],
    options?:
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)[],
    batchOptions?: RunnableBatchOptions & { returnExceptions?: false }
  ): Promise<RunOutput[]>;

  async batch(
    inputs: RunInput[],
    options?:
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]>;

  async batch(
    inputs: RunInput[],
    options?:
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)
      | (Partial<RunnableConfig> & Partial<Record<string, unknown>>)[],
    batchOptions?: RunnableBatchOptions & { returnExceptions?: boolean }
  ): Promise<(RunOutput | Error)[] | RunOutput[]> {
    // Call the batch method from the parent class with the options and batchOptions
    return super.batch(
      inputs,
      options as Partial<RunnableConfig> | Partial<RunnableConfig>[],
      batchOptions
    );
  }

  async *_transform(
    input: AsyncGenerator<RunInput>,
    runManager?: CallbackManagerForChainRun,
    config?: RunnableConfig & Partial<Record<string, unknown>>
  ): AsyncGenerator<RunOutput> {
    const newConfig: RunnableConfig & Partial<Record<string, unknown>> =
      config?.recursionLimit === undefined
        ? {
            recursionLimit: 25, // Default
            ...config,
          }
        : config;

    if (!newConfig.output) {
      throw new Error("No output specified");
    }
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
    const manager = new ChannelsManager<RunOutput>(
      this.channels,
      checkpoint
    ).manage();
    for await (const channels of manager) {
      // map inputs to channel updates
      const thisInput = this.input;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pendingWritesDeque: Array<[string, any]> = [];
      for await (const c of input) {
        for (const value of mapInput<RunInput>(thisInput, c)) {
          pendingWritesDeque.push(value);
        }
      }
      _applyWrites<RunOutput>(
        checkpoint,
        channels,
        pendingWritesDeque,
        newConfig,
        0
      );

      const read = (chan: string) => _readChannel<RunOutput>(channels, chan);

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

        const tasksWithConfig: Array<[Runnable, unknown, RunnableConfig]> =
          nextTasks.map(([proc, input, name]) => [
            proc,
            input,
            proc._patchConfig(
              {
                ...newConfig,
                runName: name,
                configurable: {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  [CONFIG_KEY_SEND]: (items: [string, any][]) =>
                    pendingWrites.push(...items),
                  [CONFIG_KEY_READ]: read,
                },
              },
              runManager?.getChild(`graph:step:${step}`)
            ),
          ]);

        // execute tasks, and wait for one to fail or all to finish.
        // each task is independent from all other concurrent tasks
        const tasks = tasksWithConfig.map(
          ([proc, input, updatedConfig]) =>
            async () => {
              if (input && typeof input === "object" && MISSING_KEY in input) {
                return proc.invoke(input[MISSING_KEY], updatedConfig);
              } else {
                return proc.invoke(input, updatedConfig);
              }
            }
        );

        await executeTasks<RunOutput>(tasks, this.stepTimeout);

        // apply writes to channels
        _applyWrites<RunOutput>(
          checkpoint,
          channels,
          pendingWrites,
          newConfig,
          step + 1
        );

        // yield current value and checkpoint view
        const stepOutput = mapOutput<RunOutput>(
          newOutputs,
          pendingWrites,
          channels
        );

        if (stepOutput) {
          if (typeof stepOutput === "object" && MISSING_KEY in stepOutput) {
            yield stepOutput[MISSING_KEY] as RunOutput;
          } else {
            yield stepOutput;
          }
          // we can detect updates when output is multiple channels (ie. object)
          if (typeof newOutputs !== "string") {
            _applyWritesFromView<RunOutput>(checkpoint, channels, stepOutput);
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
    input: RunInput,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): Promise<RunOutput> {
    let newOutput = output;
    if (newOutput === undefined) {
      if (config && "output" in config) {
        newOutput = config.output as string | string[] | undefined;
      } else {
        newOutput = this.output;
      }
    }

    let latest: RunOutput | undefined;
    for await (const chunk of await this.stream(input, config, newOutput)) {
      latest = chunk;
    }

    if (latest === undefined) {
      throw new Error('No output generated for ".invoke()"');
    }
    return latest;
  }

  async stream(
    input: RunInput,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): Promise<IterableReadableStream<RunOutput>> {
    // Convert the input object into an iterator
    // @TODO check this?
    const inputIterator: AsyncGenerator<RunInput> = (async function* () {
      yield input;
    })();
    return IterableReadableStream.fromAsyncGenerator(
      this.transform(inputIterator, { ...config, output })
    );
  }

  async *transform(
    generator: AsyncGenerator<RunInput>,
    config?: RunnableConfig & Partial<Record<string, unknown>>
  ): AsyncGenerator<RunOutput> {
    // @TODO figure out how to pass output through
    for await (const chunk of this._transformStreamWithConfig<
      RunInput,
      RunOutput
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

function _readChannel<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(
  channels: Record<string, BaseChannel<RunOutput>>,
  chan: string
): RunOutput | null {
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

function _applyWrites<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel<RunOutput>>,
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

function _applyWritesFromView<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(
  checkpoint: Checkpoint,
  channels: Record<string, BaseChannel<RunOutput>>,
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

function _prepareNextTasks<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(
  checkpoint: Checkpoint,
  processes: Record<
    string,
    ChannelInvoke<RunInput, RunOutput> | ChannelBatch<RunInput, RunOutput>
  >,
  channels: Record<string, BaseChannel<RunOutput>>
): Array<[Runnable, unknown, string]> {
  const tasks: Array<[Runnable, unknown, string]> = [];

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
            for (const [k, chan] of Object.entries(proc.channels)) {
              val[k] = _readChannel(channels, chan);
            }

            // Processes that subscribe to a single keyless channel get
            // the value directly, instead of a dict
            if (
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
              tasks.push([proc as Runnable, val, name]);
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
          tasks.push([proc as Runnable, val, name]);
          seen[proc.channel] = checkpoint.channelVersions[proc.channel];
        }
      }
    }
  }

  return tasks;
}
