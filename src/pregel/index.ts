import {
  Runnable,
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

type WriteValue<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
> =
  | Runnable<RunInput, RunOutput>
  | ((input: RunInput) => RunOutput)
  | ((input: RunInput) => Promise<RunOutput>)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | any;

function _coerceWriteValue<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
>(value: WriteValue): Runnable<RunInput, RunOutput> {
  if (!Runnable.isRunnable(value) && typeof value !== "function") {
    return _coerceToRunnable(() => value);
  }
  return _coerceToRunnable(value);
}

export class Channel {
  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    channels: string,
    key?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ChannelInvoke<RunInput, RunOutput>;

  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    channels: string[],
    key?: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): ChannelInvoke<RunInput, RunOutput>;

  static subscribeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    channels: string | string[],
    key?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    when?: (arg: any) => boolean
  ): ChannelInvoke<RunInput, RunOutput> {
    if (typeof channels !== "string" && key) {
      throw new Error(
        "Can't specify a key when subscribing to multiple channels"
      );
    }

    return new ChannelInvoke<RunInput, RunOutput>({
      channels:
        typeof channels === "string"
          ? { [key ?? ""]: channels }
          : Object.fromEntries(channels.map((chan) => [chan, chan])),
      triggers: typeof channels === "string" ? [channels] : channels,
      when,
    });
  }

  static subscribeToEach<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(inbox: string, key?: string): ChannelBatch<RunInput, RunOutput> {
    return new ChannelBatch<RunInput, RunOutput>({
      channel: inbox,
      key,
    });
  }

  static writeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(...channels: string[]): ChannelWrite<RunInput, RunOutput>;

  static writeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(...channels: string[]): ChannelWrite<RunInput, RunOutput>;

  static writeTo<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(...channels: string[]): ChannelWrite<RunInput> {
    const channelWrites: [string, Runnable<RunInput, RunOutput> | undefined][] =
      channels.map((c) => [c, undefined]);

    const kwargs: { [key: string]: WriteValue } = {};
    for (let i = 0; i < arguments.length; i += 1) {
      if (i >= channels.length) {
        const key = arguments[i];
        const value = arguments[i + 1];
        kwargs[key] = value;
        i += 1;
      }
    }

    for (const [k, v] of Object.entries(kwargs)) {
      channelWrites.push([k, _coerceWriteValue(v)]);
    }

    return new ChannelWrite<RunInput>(channelWrites);
  }
}

export interface PregelInterface<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
> {
  /**
   * @default {}
   */
  channels: Record<string, BaseChannel<RunOutput>>;
  /**
   * @default "output"
   */
  output: string | Array<string>;
  /**
   * @default "input"
   */
  input: string | Array<string>;
  /**
   * @default []
   */
  hidden: Array<string>;
  /**
   * @default false
   */
  debug: boolean;

  nodes: Record<
    string,
    ChannelInvoke<RunInput, RunOutput> | ChannelBatch<RunInput, RunOutput>
  >;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;
}

export class Pregel<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunInput extends Record<string, any> = Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
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

    validateGraph<RunInput, RunOutput>({
      nodes: this.nodes,
      channels: this.channels,
      output: this.output,
      input: this.input,
    });
  }

  async *_transform(
    input: AsyncGenerator<RunInput>,
    runManager?: CallbackManagerForChainRun,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): AsyncGenerator<RunOutput> {
    // The `_transformStreamWithConfig()` method defined in the `Runnable` class
    // has `runManager` and `config` set to optional, so we must respect that
    // in the arguments.
    if (!config) {
      throw new Error("Config (RunnableConfig) not found.");
    }
    if ((config.recursionLimit ?? 0) < 1) {
      throw new Error(`recursionLimit must be at least 1.`);
    }
    // assign defaults
    const newOutputs: string | Array<string> = output ?? [];
    if (!newOutputs && Array.isArray(newOutputs)) {
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
      checkpoint = this.saver.get(config);
    }
    checkpoint = checkpoint ?? emptyCheckpoint();
    // create channels from checkpoint
    const channelsManager = ChannelsManager<RunOutput>(
      this.channels,
      checkpoint
    );
    // @TODO how to implement equivalent of get_executor_for_config? Talk to nuno.
    for (const channels of channelsManager) {
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
        config,
        0
      );

      const read = (chan: string) => _readChannel<RunOutput>(channels, chan);

      // Similarly to Bulk Synchronous Parallel / Pregel model
      // computation proceeds in steps, while there are channel updates
      // channel updates from step N are only visible in step N+1
      // channels are guaranteed to be immutable for the duration of the step,
      // with channel updates applied only at the transition between steps
      for (let step = 0; step < (config.recursionLimit ?? 0); step += 1) {
        const nextTasks = _prepareNextTasks<RunInput, RunOutput>(
          checkpoint,
          processes,
          channels
        );

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
            patchConfig({
              config,
              runName: name,
              callbacks: runManager?.getChild(`graph:step:${step}`),
              configurable: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                CONFIG_KEY_SEND: (...items: [string, any][]) =>
                  pendingWrites.push(...items),
                CONFIG_KEY_READ: read,
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
        try {
          await executeTasks(tasks, this.stepTimeout);
        } catch (error) {
          // Handle error (FIRST_EXCEPTION behavior)
          // @TODO how to handle this?
        }

        // @TODO next in PY the function `_interrupt_or_proceed()` is called.
        // I don't think that's necessary here b/c of above logic?

        // apply writes to channels
        _applyWrites<RunOutput>(
          checkpoint,
          channels,
          pendingWrites,
          config,
          step + 1
        );

        // yield current value and checkpoint view
        const stepOutput = mapOutput<RunOutput>(
          newOutputs,
          pendingWrites,
          channels
        );
        if (stepOutput) {
          yield stepOutput;
          // we can detect updates when output is multiple channels (ie. object)
          if (typeof newOutputs !== "string") {
            _applyWritesFromView<RunOutput>(checkpoint, channels, stepOutput);
          }
        }

        // save end of step checkpoint
        if (this.saver && this.saver.at === CheckpointAt.END_OF_STEP) {
          checkpoint = await createCheckpoint(checkpoint, channels);
          this.saver.put(config, checkpoint);
        }
      }

      // save end of run checkpoint
      if (this.saver && this.saver.at === CheckpointAt.END_OF_RUN) {
        checkpoint = await createCheckpoint(checkpoint, channels);
        this.saver.put(config, checkpoint);
      }
    }
  }

  async invoke(
    input: RunInput,
    config?: RunnableConfig,
    output?: string | Array<string>
  ): Promise<RunOutput> {
    let latest: RunOutput | undefined;
    for await (const chunk of await this.stream(
      input,
      config,
      output ?? this.output
    )) {
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
      this.transform(inputIterator, config, output)
    );
  }

  async *transform(
    generator: AsyncGenerator<RunInput>,
    options?: RunnableConfig,
    _output?: string | Array<string>
  ): AsyncGenerator<RunOutput> {
    // @TODO figure out how to pass output through
    for await (const chunk of this._transformStreamWithConfig<
      RunInput,
      RunOutput
    >(generator, this._transform, options)) {
      yield chunk;
    }
  }
}

async function executeTasks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Array<() => Promise<any>>,
  stepTimeout?: number
): Promise<void> {
  const inflight = tasks.map((task) => task());

  try {
    await Promise.all(inflight.map((p) => p.catch((e) => e)));
  } catch (error) {
    console.error("should I handle another way?");
    // If any promise rejects, this catch block will execute.
    // Cancel all pending tasks (if applicable) and handle the error.
    throw error;
  }

  // Apply timeout if needed
  if (stepTimeout) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timed out")), stepTimeout);
    });
    inflight.push(timeoutPromise);
  }

  // Wait for the first task to complete or fail
  await Promise.race(inflight);

  // Check for any errors in the tasks
  for (const task of inflight) {
    if (
      // eslint-disable-next-line no-instanceof/no-instanceof
      task instanceof Promise &&
      // eslint-disable-next-line no-instanceof/no-instanceof
      (await task.catch((e) => e)) instanceof Error
    ) {
      // @TODO what is the proper way to handle errors?
      throw new Error("A task failed");
    }
  }
}

/** @TODO import from `@langchain/core` once included in new release */
function patchConfig({
  config,
  callbacks,
  recursionLimit,
  runName,
  configurable,
}: {
  config?: RunnableConfig;
  callbacks?: CallbackManager;
  recursionLimit?: number;
  runName?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configurable?: Record<string, any>;
}): RunnableConfig {
  const newConfig = { ...config };
  if (callbacks) {
    newConfig.callbacks = callbacks;
    if ("runName" in newConfig) {
      delete newConfig.runName;
    }
  }
  if (recursionLimit) {
    newConfig.recursionLimit = recursionLimit;
  }
  if (runName) {
    newConfig.runName = runName;
  }
  if (configurable) {
    newConfig.configurable = {
      ...(newConfig.configurable ? newConfig.configurable : {}),
      ...configurable,
    };
  }
  return newConfig;
}

function _readChannel<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
>(channels: Record<string, BaseChannel<RunOutput>>, chan: string) {
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
  RunOutput extends Record<string, any> = Record<string, any>
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
    pendingWritesByChannel[chan].push(val);
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
        // eslint-disable-next-line no-param-reassign
        checkpoint.channelVersions[chan] += 1;
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
  RunOutput extends Record<string, any> = Record<string, any>
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
  RunInput extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
>(
  checkpoint: Checkpoint,
  processes: Record<
    string,
    ChannelInvoke<RunInput, RunOutput> | ChannelBatch<RunInput, RunOutput>
  >,
  channels: Record<string, BaseChannel<RunOutput>>
): Array<[Runnable, unknown, string]> {
  const tasks: Array<[Runnable, unknown, string]> = [];

  for (const [name, proc] of Object.entries(processes)) {
    const seen = checkpoint.versionsSeen[name];
    // @TODO remove, only here b/c no-unused vars
    console.log(seen, channels);
    if (proc.lc_graph_name === "ChannelInvoke") {
      // todo implement
    } else if (proc.lc_graph_name === "ChannelBatch") {
      // todo implement
    }
  }
  return tasks;
}
