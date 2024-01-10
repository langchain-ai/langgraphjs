import { Runnable, RunnableConfig } from "@langchain/core/runnables";
import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  BaseChannel,
  ChannelsManager,
  EmptyChannelError
} from "../channels/base.js";
import {
  BaseCheckpointSaver,
  Checkpoint,
  ConfigurableFieldSpec,
  emptyCheckpoint
} from "../checkpoint/base.js";
import { ChannelBatch, ChannelInvoke } from "./read.js";
import { validateGraph } from "./validate.js";
import { ReservedChannels } from "./reserved.js";
import { LastValue } from "../channels/last_value.js";

function getUniqueConfigSpecs(
  specs: Iterable<ConfigurableFieldSpec>
): Array<ConfigurableFieldSpec> {
  const sortedSpecs = Array.from(specs).sort((a, b) => {
    const depA = a.dependencies || [];
    const depB = b.dependencies || [];
    return a.id.localeCompare(b.id) || depA.length - depB.length;
  });

  const unique: ConfigurableFieldSpec[] = [];
  const grouped = sortedSpecs.reduce((acc, spec) => {
    (acc[spec.id] = acc[spec.id] || []).push(spec);
    return acc;
  }, {} as Record<string, ConfigurableFieldSpec[]>);

  for (const id in grouped) {
    if (id in grouped) {
      const [first, ...others] = grouped[id];
      if (
        others.length === 0 ||
        others.every((o) => JSON.stringify(o) === JSON.stringify(first))
      ) {
        unique.push(first);
      } else {
        throw new Error(
          `RunnableSequence contains conflicting config specs for ${id}: ${JSON.stringify(
            [first, ...others]
          )}`
        );
      }
    }
  }

  return unique;
}

interface PregelInterface {
  /**
   * @default {}
   */
  channels: Record<string, BaseChannel>;
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

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;

  /**
   * @TODO fix return type
   */
  getInputSchema(config?: RunnableConfig): unknown;

  /**
   * @TODO fix return type
   */
  getOutputSchema(config?: RunnableConfig): unknown;
}

export class Pregel implements PregelInterface {
  channels: Record<string, BaseChannel> = {};

  output: string | Array<string> = "output";

  input: string | Array<string> = "input";

  hidden: Array<string> = [];

  debug: boolean = false;

  nodes: Record<string, ChannelInvoke | ChannelBatch>;

  saver?: BaseCheckpointSaver;

  stepTimeout?: number;

  constructor(fields: PregelInterface) {
    this.channels = fields.channels ?? this.channels;
    this.output = fields.output ?? this.output;
    this.input = fields.input ?? this.input;
    this.hidden = fields.hidden ?? this.hidden;
    this.debug = fields.debug ?? this.debug;
    this.nodes = fields.nodes;
    this.saver = fields.saver;
    this.stepTimeout = fields.stepTimeout;

    validateGraph({
      nodes: this.nodes,
      channels: this.channels,
      output: this.output,
      input: this.input
    });
  }

  get configSpecs(): Array<ConfigurableFieldSpec> {
    throw new Error("TODO: implement");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get InputType(): any {
    if (typeof this.input === "string") {
      return this.channels[this.input].UpdateType;
    }
  }

  getInputSchema(_config?: RunnableConfig): unknown {
    throw new Error("TODO: implement");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get OutputType(): any {
    if (typeof this.output === "string") {
      return this.channels[this.output].ValueType;
    }
  }

  getOutputSchema(_config?: RunnableConfig): unknown {
    throw new Error("TODO: implement");
  }

  _transform(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Iterator<Record<string, any> | any>,
    runManager: CallbackManagerForChainRun,
    config: RunnableConfig,
    output?: string | Array<string>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Generator<Record<string, any> | any> {
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
    const channelsManager = ChannelsManager(this.channels, checkpoint);
    // @TODO how to implement equivalent of get_executor_for_config? Talk to nuno.
  }
}

/**
def _interrupt_or_proceed(
    done: Union[set[concurrent.futures.Future[Any]], set[asyncio.Task[Any]]],
    inflight: Union[set[concurrent.futures.Future[Any]], set[asyncio.Task[Any]]],
    step: int,
) -> None:
    while done:
        # if any task failed
        if exc := done.pop().exception():
            # cancel all pending tasks
            while inflight:
                inflight.pop().cancel()
            # raise the exception
            raise exc
            # TODO this is where retry of an entire step would happen

    if inflight:
        # if we got here means we timed out
        while inflight:
            # cancel all pending tasks
            inflight.pop().cancel()
        # raise timeout error
        raise TimeoutError(f"Timed out at step {step}")
 */

function _interruptOrProceed() {
  throw new Error("Can this be implemented? Or how to in a TS way?");
}

function _readChannel(channels: Record<string, BaseChannel>, chan: string) {
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
    pendingWritesByChannel[chan].push(val);
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

/**
def _prepare_next_tasks(
    checkpoint: Checkpoint,
    processes: Mapping[str, Union[ChannelInvoke, ChannelBatch]],
    channels: Mapping[str, BaseChannel],
) -> list[tuple[Runnable, Any, str]]:
    tasks: list[tuple[Runnable, Any, str]] = []
    # Check if any processes should be run in next step
    # If so, prepare the values to be passed to them
    for name, proc in processes.items():
        seen = checkpoint["versions_seen"][name]
        if isinstance(proc, ChannelInvoke):
            # If any of the channels read by this process were updated
            if any(
                checkpoint["channel_versions"][chan] > seen[chan]
                for chan in proc.triggers
            ):
                # If all channels subscribed by this process have been initialized
                try:
                    val: Any = {
                        k: _read_channel(
                            channels, chan, catch=chan not in proc.triggers
                        )
                        for k, chan in proc.channels.items()
                    }
                except EmptyChannelError:
                    continue

                # Processes that subscribe to a single keyless channel get
                # the value directly, instead of a dict
                if list(proc.channels.keys()) == [None]:
                    val = val[None]

                # update seen versions
                seen.update(
                    {
                        chan: checkpoint["channel_versions"][chan]
                        for chan in proc.triggers
                    }
                )

                # skip if condition is not met
                if proc.when is None or proc.when(val):
                    tasks.append((proc, val, name))
        elif isinstance(proc, ChannelBatch):
            # If the channel read by this process was updated
            if checkpoint["channel_versions"][proc.channel] > seen[proc.channel]:
                # Here we don't catch EmptyChannelError because the channel
                # must be intialized if the previous `if` condition is true
                val = channels[proc.channel].get()
                if proc.key is not None:
                    val = [{proc.key: v} for v in val]

                tasks.append((proc, val, name))
                seen[proc.channel] = checkpoint["channel_versions"][proc.channel]

    return tasks
 */
function _prepareNextTasks(
  checkpoint: Checkpoint,
  processes: Record<string, ChannelInvoke | ChannelBatch>,
  channels: Record<string, BaseChannel>
): Array<[Runnable, unknown, string]> {
  const tasks: Array<[Runnable, unknown, string]> = [];
  for (const [name, proc] of Object.entries(processes)) {
    const seen = checkpoint.versionsSeen[name];
    if (proc.lc_graph_name === "ChannelInvoke") {
      // todo implement
    } else if (proc.lc_graph_name === "ChannelBatch") {
      // todo implement
    }
  }
  return tasks;
}
