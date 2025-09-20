/* eslint-disable no-param-reassign */
import {
  _coerceToRunnable,
  getCallbackManagerForConfig,
  mergeConfigs,
  patchConfig,
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableLike,
  RunnableSequence,
} from "@langchain/core/runnables";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  All,
  BaseCache,
  BaseCheckpointSaver,
  BaseStore,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  compareChannelVersions,
  copyCheckpoint,
  emptyCheckpoint,
  PendingWrite,
  SCHEDULED,
  SendProtocol,
  uuid5,
} from "@langchain/langgraph-checkpoint";
import {
  BaseChannel,
  createCheckpoint,
  emptyChannels,
  getOnlyChannels,
} from "../channels/base.js";
import {
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Command,
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_NODE_FINISHED,
  CONFIG_KEY_READ,
  CONFIG_KEY_SEND,
  CONFIG_KEY_STREAM,
  CONFIG_KEY_TASK_ID,
  COPY,
  END,
  ERROR,
  INPUT,
  INTERRUPT,
  Interrupt,
  isInterrupted,
  NULL_TASK_ID,
  PUSH,
  CONFIG_KEY_DURABILITY,
  CONFIG_KEY_CHECKPOINT_NS,
  type CommandInstance,
  TASKS,
} from "../constants.js";
import {
  GraphRecursionError,
  GraphValueError,
  InvalidUpdateError,
} from "../errors.js";
import { gatherIterator, patchConfigurable } from "../utils.js";
import {
  _applyWrites,
  _localRead,
  _prepareNextTasks,
  StrRecord,
  WritesProtocol,
} from "./algo.js";
import {
  printStepCheckpoint,
  printStepTasks,
  printStepWrites,
  tasksWithWrites,
} from "./debug.js";
import { mapInput, readChannels } from "./io.js";
import { PregelLoop } from "./loop.js";
import { StreamMessagesHandler } from "./messages.js";
import { PregelNode } from "./read.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
import { PregelRunner } from "./runner.js";
import {
  IterableReadableStreamWithAbortSignal,
  IterableReadableWritableStream,
  toEventStream,
} from "./stream.js";
import type {
  Durability,
  GetStateOptions,
  MultipleChannelSubscriptionOptions,
  PregelExecutableTask,
  PregelInputType,
  PregelInterface,
  PregelOptions,
  PregelOutputType,
  PregelParams,
  SingleChannelSubscriptionOptions,
  StateSnapshot,
  StreamMode,
  StreamOutputMap,
} from "./types.js";
import {
  ensureLangGraphConfig,
  getConfig,
  recastCheckpointNamespace,
} from "./utils/config.js";
import {
  _coerceToDict,
  combineAbortSignals,
  combineCallbacks,
  getNewChannelVersions,
  patchCheckpointMap,
  RetryPolicy,
} from "./utils/index.js";
import { findSubgraphPregel } from "./utils/subgraph.js";
import { validateGraph, validateKeys } from "./validate.js";
import { ChannelWrite, ChannelWriteEntry, PASSTHROUGH } from "./write.js";
import { Topic } from "../channels/topic.js";
import { interrupt } from "../interrupt.js";

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;
type StreamEventsOptions = Parameters<Runnable["streamEvents"]>[2];

/**
 * Utility class for working with channels in the Pregel system.
 * Provides static methods for subscribing to channels and writing to them.
 *
 * Channels are the communication pathways between nodes in a Pregel graph.
 * They enable message passing and state updates between different parts of the graph.
 */
export class Channel {
  /**
   * Creates a PregelNode that subscribes to a single channel.
   * This is used to define how nodes receive input from channels.
   *
   * @example
   * ```typescript
   * // Subscribe to a single channel
   * const node = Channel.subscribeTo("messages");
   *
   * // Subscribe to multiple channels
   * const node = Channel.subscribeTo(["messages", "state"]);
   *
   * // Subscribe with a custom key
   * const node = Channel.subscribeTo("messages", { key: "chat" });
   * ```
   *
   * @param channel - Single channel name to subscribe to
   * @param options - Subscription options
   * @returns A PregelNode configured to receive from the specified channels
   * @throws {Error} If a key is specified when subscribing to multiple channels
   */
  static subscribeTo(
    channel: string,
    options?: SingleChannelSubscriptionOptions
  ): PregelNode;

  /**
   * Creates a PregelNode that subscribes to multiple channels.
   * This is used to define how nodes receive input from channels.
   *
   * @example
   * ```typescript
   * // Subscribe to a single channel
   * const node = Channel.subscribeTo("messages");
   *
   * // Subscribe to multiple channels
   * const node = Channel.subscribeTo(["messages", "state"]);
   *
   * // Subscribe with a custom key
   * const node = Channel.subscribeTo("messages", { key: "chat" });
   * ```
   *
   * @param channel - Single channel name to subscribe to
   * @param options - Subscription options
   * @returns A PregelNode configured to receive from the specified channels
   * @throws {Error} If a key is specified when subscribing to multiple channels
   */
  static subscribeTo(
    channels: string[],
    options?: MultipleChannelSubscriptionOptions
  ): PregelNode;

  static subscribeTo(
    channels: string | string[],
    options?:
      | SingleChannelSubscriptionOptions
      | MultipleChannelSubscriptionOptions
  ): PregelNode {
    const { key, tags } = {
      key: undefined,
      tags: undefined,
      ...(options ?? {}),
    };
    if (Array.isArray(channels) && key !== undefined) {
      throw new Error(
        "Can't specify a key when subscribing to multiple channels"
      );
    }

    let channelMappingOrArray: string[] | Record<string, string>;

    if (typeof channels === "string") {
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

  /**
   * Creates a ChannelWrite that specifies how to write values to channels.
   * This is used to define how nodes send output to channels.
   *
   * @example
   * ```typescript
   * // Write to multiple channels
   * const write = Channel.writeTo(["output", "state"]);
   *
   * // Write with specific values
   * const write = Channel.writeTo(["output"], {
   *   state: "completed",
   *   result: calculateResult()
   * });
   *
   * // Write with a transformation function
   * const write = Channel.writeTo(["output"], {
   *   result: (x) => processResult(x)
   * });
   * ```
   *
   * @param channels - Array of channel names to write to
   * @param writes - Optional map of channel names to values or transformations
   * @returns A ChannelWrite object that can be used to write to the specified channels
   */
  static writeTo(
    channels: string[],
    writes?: Record<string, WriteValue>
  ): ChannelWrite {
    const channelWriteEntries: Array<ChannelWriteEntry> = [];

    for (const channel of channels) {
      channelWriteEntries.push({
        channel,
        value: PASSTHROUGH,
        skipNone: false,
      });
    }

    for (const [key, value] of Object.entries(writes ?? {})) {
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

export type { PregelInputType, PregelOptions, PregelOutputType };

// This is a workaround to allow Pregel to override `invoke` / `stream` and `withConfig`
// without having to adhere to the types in the `Runnable` class (thanks to `any`).
// Alternatively we could mark those methods with @ts-ignore / @ts-expect-error,
// but these do not get carried over when building via `tsc`.
class PartialRunnable<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig
> extends Runnable<RunInput, RunOutput, CallOptions> {
  lc_namespace = ["langgraph", "pregel"];

  override invoke(
    _input: RunInput,
    _options?: Partial<CallOptions>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    throw new Error("Not implemented");
  }

  // Overriden by `Pregel`
  override withConfig(_config: CallOptions): typeof this {
    return super.withConfig(_config) as typeof this;
  }

  // Overriden by `Pregel`
  override stream(
    input: RunInput,
    options?: Partial<CallOptions>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<IterableReadableStream<any>> {
    return super.stream(input, options);
  }
}

/**
 * The Pregel class is the core runtime engine of LangGraph, implementing a message-passing graph computation model
 * inspired by [Google's Pregel system](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/).
 * It provides the foundation for building reliable, controllable agent workflows that can evolve state over time.
 *
 * Key features:
 * - Message passing between nodes in discrete "supersteps"
 * - Built-in persistence layer through checkpointers
 * - First-class streaming support for values, updates, and events
 * - Human-in-the-loop capabilities via interrupts
 * - Support for parallel node execution within supersteps
 *
 * The Pregel class is not intended to be instantiated directly by consumers. Instead, use the following higher-level APIs:
 * - {@link StateGraph}: The main graph class for building agent workflows
 *   - Compiling a {@link StateGraph} will return a {@link CompiledGraph} instance, which extends `Pregel`
 * - Functional API: A declarative approach using tasks and entrypoints
 *   - A `Pregel` instance is returned by the {@link entrypoint} function
 *
 * @example
 * ```typescript
 * // Using StateGraph API
 * const graph = new StateGraph(annotation)
 *   .addNode("nodeA", myNodeFunction)
 *   .addEdge("nodeA", "nodeB")
 *   .compile();
 *
 * // The compiled graph is a Pregel instance
 * const result = await graph.invoke(input);
 * ```
 *
 * @example
 * ```typescript
 * // Using Functional API
 * import { task, entrypoint } from "@langchain/langgraph";
 * import { MemorySaver } from "@langchain/langgraph-checkpoint";
 *
 * // Define tasks that can be composed
 * const addOne = task("add", async (x: number) => x + 1);
 *
 * // Create a workflow using the entrypoint function
 * const workflow = entrypoint({
 *   name: "workflow",
 *   checkpointer: new MemorySaver()
 * }, async (numbers: number[]) => {
 *   // Tasks can be run in parallel
 *   const results = await Promise.all(numbers.map(n => addOne(n)));
 *   return results;
 * });
 *
 * // The workflow is a Pregel instance
 * const result = await workflow.invoke([1, 2, 3]); // Returns [2, 3, 4]
 * ```
 *
 * @typeParam Nodes - Mapping of node names to their {@link PregelNode} implementations
 * @typeParam Channels - Mapping of channel names to their {@link BaseChannel} or {@link ManagedValueSpec} implementations
 * @typeParam ContextType - Type of context that can be passed to the graph
 * @typeParam InputType - Type of input values accepted by the graph
 * @typeParam OutputType - Type of output values produced by the graph
 */
export class Pregel<
    Nodes extends StrRecord<string, PregelNode>,
    Channels extends StrRecord<string, BaseChannel>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ContextType extends Record<string, any> = StrRecord<string, any>,
    InputType = PregelInputType,
    OutputType = PregelOutputType,
    StreamUpdatesType = InputType,
    StreamValuesType = OutputType,
    NodeReturnType = unknown,
    CommandType = CommandInstance,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    StreamCustom = any
  >
  extends PartialRunnable<
    InputType | CommandType | null,
    OutputType,
    PregelOptions<Nodes, Channels, ContextType>
  >
  implements PregelInterface<Nodes, Channels, ContextType>
{
  /**
   * Name of the class when serialized
   * @internal
   */
  static lc_name() {
    return "LangGraph";
  }

  /** @internal Used for type inference */
  declare "~InputType": InputType;

  /** @internal Used for type inference */
  declare "~OutputType": OutputType;

  /** @internal LangChain namespace for serialization necessary because Pregel extends Runnable */
  lc_namespace = ["langgraph", "pregel"];

  /** @internal Flag indicating this is a Pregel instance - necessary for serialization */
  lg_is_pregel = true;

  /** The nodes in the graph, mapping node names to their PregelNode instances */
  nodes: Nodes;

  /** The channels in the graph, mapping channel names to their BaseChannel or ManagedValueSpec instances */
  channels: Channels;

  /**
   * The input channels for the graph. These channels receive the initial input when the graph is invoked.
   * Can be a single channel key or an array of channel keys.
   */
  inputChannels: keyof Channels | Array<keyof Channels>;

  /**
   * The output channels for the graph. These channels contain the final output when the graph completes.
   * Can be a single channel key or an array of channel keys.
   */
  outputChannels: keyof Channels | Array<keyof Channels>;

  /** Whether to automatically validate the graph structure when it is compiled. Defaults to true. */
  autoValidate: boolean = true;

  /**
   * The streaming modes enabled for this graph. Defaults to ["values"].
   * Supported modes:
   * - "values": Streams the full state after each step
   * - "updates": Streams state updates after each step
   * - "messages": Streams messages from within nodes
   * - "custom": Streams custom events from within nodes
   * - "debug": Streams events related to the execution of the graph - useful for tracing & debugging graph execution
   */
  streamMode: StreamMode[] = ["values"];

  /**
   * Optional channels to stream. If not specified, all channels will be streamed.
   * Can be a single channel key or an array of channel keys.
   */
  streamChannels?: keyof Channels | Array<keyof Channels>;

  /**
   * Optional array of node names or "all" to interrupt after executing these nodes.
   * Used for implementing human-in-the-loop workflows.
   */
  interruptAfter?: Array<keyof Nodes> | All;

  /**
   * Optional array of node names or "all" to interrupt before executing these nodes.
   * Used for implementing human-in-the-loop workflows.
   */
  interruptBefore?: Array<keyof Nodes> | All;

  /** Optional timeout in milliseconds for the execution of each superstep */
  stepTimeout?: number;

  /** Whether to enable debug logging. Defaults to false. */
  debug: boolean = false;

  /**
   * Optional checkpointer for persisting graph state.
   * When provided, saves a checkpoint of the graph state at every superstep.
   * When false or undefined, checkpointing is disabled, and the graph will not be able to save or restore state.
   */
  checkpointer?: BaseCheckpointSaver | boolean;

  /** Optional retry policy for handling failures in node execution */
  retryPolicy?: RetryPolicy;

  /** The default configuration for graph execution, can be overridden on a per-invocation basis */
  config?: LangGraphRunnableConfig;

  /**
   * Optional long-term memory store for the graph, allows for persistence & retrieval of data across threads
   */
  store?: BaseStore;

  /**
   * Optional cache for the graph, useful for caching tasks.
   */
  cache?: BaseCache;

  /**
   * Optional interrupt helper function.
   * @internal
   */
  private userInterrupt?: unknown;

  /**
   * The trigger to node mapping for the graph run.
   * @internal
   */
  private triggerToNodes: Record<string, string[]> = {};

  /**
   * Constructor for Pregel - meant for internal use only.
   *
   * @internal
   */
  constructor(fields: PregelParams<Nodes, Channels>) {
    super(fields);

    let { streamMode } = fields;
    if (streamMode != null && !Array.isArray(streamMode)) {
      streamMode = [streamMode];
    }

    this.nodes = fields.nodes;
    this.channels = fields.channels;

    if (
      TASKS in this.channels &&
      "lc_graph_name" in this.channels[TASKS] &&
      this.channels[TASKS].lc_graph_name !== "Topic"
    ) {
      throw new Error(
        `Channel '${TASKS}' is reserved and cannot be used in the graph.`
      );
    } else {
      (this.channels as Record<string, BaseChannel>)[TASKS] =
        new Topic<SendProtocol>({ accumulate: false });
    }

    this.autoValidate = fields.autoValidate ?? this.autoValidate;
    this.streamMode = streamMode ?? this.streamMode;
    this.inputChannels = fields.inputChannels;
    this.outputChannels = fields.outputChannels;
    this.streamChannels = fields.streamChannels ?? this.streamChannels;
    this.interruptAfter = fields.interruptAfter;
    this.interruptBefore = fields.interruptBefore;
    this.stepTimeout = fields.stepTimeout ?? this.stepTimeout;
    this.debug = fields.debug ?? this.debug;
    this.checkpointer = fields.checkpointer;
    this.retryPolicy = fields.retryPolicy;
    this.config = fields.config;
    this.store = fields.store;
    this.cache = fields.cache;
    this.name = fields.name;
    this.triggerToNodes = fields.triggerToNodes ?? this.triggerToNodes;
    this.userInterrupt = fields.userInterrupt;

    if (this.autoValidate) {
      this.validate();
    }
  }

  /**
   * Creates a new instance of the Pregel graph with updated configuration.
   * This method follows the immutable pattern - instead of modifying the current instance,
   * it returns a new instance with the merged configuration.
   *
   * @example
   * ```typescript
   * // Create a new instance with debug enabled
   * const debugGraph = graph.withConfig({ debug: true });
   *
   * // Create a new instance with a specific thread ID
   * const threadGraph = graph.withConfig({
   *   configurable: { thread_id: "123" }
   * });
   * ```
   *
   * @param config - The configuration to merge with the current configuration
   * @returns A new Pregel instance with the merged configuration
   */
  override withConfig(
    config: Omit<LangGraphRunnableConfig, "store" | "writer" | "interrupt">
  ): typeof this {
    const mergedConfig = mergeConfigs(this.config, config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (this.constructor as any)({ ...this, config: mergedConfig });
  }

  /**
   * Validates the graph structure to ensure it is well-formed.
   * Checks for:
   * - No orphaned nodes
   * - Valid input/output channel configurations
   * - Valid interrupt configurations
   *
   * @returns this - The Pregel instance for method chaining
   * @throws {GraphValidationError} If the graph structure is invalid
   */
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

    for (const [name, node] of Object.entries(this.nodes)) {
      for (const trigger of node.triggers) {
        this.triggerToNodes[trigger] ??= [];
        this.triggerToNodes[trigger].push(name);
      }
    }

    return this;
  }

  /**
   * Gets a list of all channels that should be streamed.
   * If streamChannels is specified, returns those channels.
   * Otherwise, returns all channels in the graph.
   *
   * @returns Array of channel keys to stream
   */
  get streamChannelsList(): Array<keyof Channels> {
    if (Array.isArray(this.streamChannels)) {
      return this.streamChannels;
    } else if (this.streamChannels) {
      return [this.streamChannels];
    } else {
      return Object.keys(this.channels);
    }
  }

  /**
   * Gets the channels to stream in their original format.
   * If streamChannels is specified, returns it as-is (either single key or array).
   * Otherwise, returns all channels in the graph as an array.
   *
   * @returns Channel keys to stream, either as a single key or array
   */
  get streamChannelsAsIs(): keyof Channels | Array<keyof Channels> {
    if (this.streamChannels) {
      return this.streamChannels;
    } else {
      return Object.keys(this.channels);
    }
  }

  /**
   * Gets a drawable representation of the graph structure.
   * This is an async version of getGraph() and is the preferred method to use.
   *
   * @param config - Configuration for generating the graph visualization
   * @returns A representation of the graph that can be visualized
   */
  async getGraphAsync(config: RunnableConfig) {
    return this.getGraph(config);
  }

  /**
   * Gets all subgraphs within this graph.
   * A subgraph is a Pregel instance that is nested within a node of this graph.
   *
   * @deprecated Use getSubgraphsAsync instead. The async method will become the default in the next minor release.
   * @param namespace - Optional namespace to filter subgraphs
   * @param recurse - Whether to recursively get subgraphs of subgraphs
   * @returns Generator yielding tuples of [name, subgraph]
   */
  *getSubgraphs(
    namespace?: string,
    recurse?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Generator<[string, Pregel<any, any>]> {
    for (const [name, node] of Object.entries(this.nodes)) {
      // filter by prefix
      if (namespace !== undefined) {
        if (!namespace.startsWith(name)) {
          continue;
        }
      }
      // find the subgraph if any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type SubgraphPregelType = Pregel<any, any> | undefined;

      const candidates = node.subgraphs?.length ? node.subgraphs : [node.bound];

      for (const candidate of candidates) {
        const graph = findSubgraphPregel(candidate) as SubgraphPregelType;

        if (graph !== undefined) {
          if (name === namespace) {
            yield [name, graph];
            return;
          }

          if (namespace === undefined) {
            yield [name, graph];
          }

          if (recurse) {
            let newNamespace = namespace;
            if (namespace !== undefined) {
              newNamespace = namespace.slice(name.length + 1);
            }
            for (const [subgraphName, subgraph] of graph.getSubgraphs(
              newNamespace,
              recurse
            )) {
              yield [
                `${name}${CHECKPOINT_NAMESPACE_SEPARATOR}${subgraphName}`,
                subgraph,
              ];
            }
          }
        }
      }
    }
  }

  /**
   * Gets all subgraphs within this graph asynchronously.
   * A subgraph is a Pregel instance that is nested within a node of this graph.
   *
   * @param namespace - Optional namespace to filter subgraphs
   * @param recurse - Whether to recursively get subgraphs of subgraphs
   * @returns AsyncGenerator yielding tuples of [name, subgraph]
   */
  async *getSubgraphsAsync(
    namespace?: string,
    recurse?: boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<[string, Pregel<any, any>]> {
    yield* this.getSubgraphs(namespace, recurse);
  }

  /**
   * Prepares a state snapshot from saved checkpoint data.
   * This is an internal method used by getState and getStateHistory.
   *
   * @param config - Configuration for preparing the snapshot
   * @param saved - Optional saved checkpoint data
   * @param subgraphCheckpointer - Optional checkpointer for subgraphs
   * @param applyPendingWrites - Whether to apply pending writes to tasks and then to channels
   * @returns A snapshot of the graph state
   * @internal
   */
  protected async _prepareStateSnapshot({
    config,
    saved,
    subgraphCheckpointer,
    applyPendingWrites = false,
  }: {
    config: RunnableConfig;
    saved?: CheckpointTuple;
    subgraphCheckpointer?: BaseCheckpointSaver;
    applyPendingWrites?: boolean;
  }): Promise<StateSnapshot> {
    if (saved === undefined) {
      return {
        values: {},
        next: [],
        config,
        tasks: [],
      };
    }

    // Create all channels
    const channels = emptyChannels(
      this.channels as Record<string, BaseChannel>,
      saved.checkpoint
    );

    // Apply null writes first (from NULL_TASK_ID)
    if (saved.pendingWrites?.length) {
      const nullWrites = saved.pendingWrites
        .filter(([taskId, _]) => taskId === NULL_TASK_ID)
        .map(
          ([_, channel, value]) => [String(channel), value] as [string, unknown]
        );

      if (nullWrites.length > 0) {
        _applyWrites(
          saved.checkpoint,
          channels,
          [
            {
              name: INPUT,
              writes: nullWrites as PendingWrite[],
              triggers: [],
            },
          ],
          undefined,
          this.triggerToNodes
        );
      }
    }

    // Prepare next tasks
    const nextTasks = Object.values(
      _prepareNextTasks(
        saved.checkpoint,
        saved.pendingWrites,
        this.nodes,
        channels,
        saved.config,
        true,
        { step: (saved.metadata?.step ?? -1) + 1, store: this.store }
      )
    );

    // Find subgraphs
    const subgraphs = await gatherIterator(this.getSubgraphsAsync());
    const parentNamespace = saved.config.configurable?.checkpoint_ns ?? "";
    const taskStates: Record<string, RunnableConfig | StateSnapshot> = {};

    // Prepare task states for subgraphs
    for (const task of nextTasks) {
      const matchingSubgraph = subgraphs.find(([name]) => name === task.name);
      if (!matchingSubgraph) {
        continue;
      }
      // assemble checkpoint_ns for this task
      let taskNs = `${String(task.name)}${CHECKPOINT_NAMESPACE_END}${task.id}`;
      if (parentNamespace) {
        taskNs = `${parentNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${taskNs}`;
      }
      if (subgraphCheckpointer === undefined) {
        // set config as signal that subgraph checkpoints exist
        const config: RunnableConfig = {
          configurable: {
            thread_id: saved.config.configurable?.thread_id,
            checkpoint_ns: taskNs,
          },
        };
        taskStates[task.id] = config;
      } else {
        // get the state of the subgraph
        const subgraphConfig: RunnableConfig = {
          configurable: {
            [CONFIG_KEY_CHECKPOINTER]: subgraphCheckpointer,
            thread_id: saved.config.configurable?.thread_id,
            checkpoint_ns: taskNs,
          },
        };
        const pregel = matchingSubgraph[1];
        taskStates[task.id] = await pregel.getState(subgraphConfig, {
          subgraphs: true,
        });
      }
    }

    // Apply pending writes to tasks and then to channels if applyPendingWrites is true
    if (applyPendingWrites && saved.pendingWrites?.length) {
      // Map task IDs to task objects for easy lookup
      const nextTaskById = Object.fromEntries(
        nextTasks.map((task) => [task.id, task])
      );

      // Apply pending writes to the appropriate tasks
      for (const [taskId, channel, value] of saved.pendingWrites) {
        // Skip special channels and tasks not in nextTasks
        if ([ERROR, INTERRUPT, SCHEDULED].includes(channel)) {
          continue;
        }
        if (!(taskId in nextTaskById)) {
          continue;
        }
        // Add the write to the task
        nextTaskById[taskId].writes.push([String(channel), value]);
      }

      // Apply writes from tasks that have writes
      const tasksWithWrites = nextTasks.filter(
        (task) => task.writes.length > 0
      );
      if (tasksWithWrites.length > 0) {
        _applyWrites(
          saved.checkpoint,
          channels,
          tasksWithWrites as unknown as WritesProtocol[],
          undefined,
          this.triggerToNodes
        );
      }
    }

    // Preserve thread_id from the config in metadata
    let metadata = saved?.metadata;
    if (metadata && saved?.config?.configurable?.thread_id) {
      metadata = {
        ...metadata,
        thread_id: saved.config.configurable.thread_id as string,
      } as CheckpointMetadata;
    }

    // Filter next tasks - only include tasks without writes
    const nextList = nextTasks
      .filter((task) => task.writes.length === 0)
      .map((task) => task.name as string);

    // assemble the state snapshot
    return {
      values: readChannels(
        channels,
        this.streamChannelsAsIs as string | string[]
      ),
      next: nextList,
      tasks: tasksWithWrites(
        nextTasks,
        saved?.pendingWrites ?? [],
        taskStates,
        this.streamChannelsAsIs
      ),
      metadata,
      config: patchCheckpointMap(saved.config, saved.metadata),
      createdAt: saved.checkpoint.ts,
      parentConfig: saved.parentConfig,
    };
  }

  /**
   * Gets the current state of the graph.
   * Requires a checkpointer to be configured.
   *
   * @param config - Configuration for retrieving the state
   * @param options - Additional options
   * @returns A snapshot of the current graph state
   * @throws {GraphValueError} If no checkpointer is configured
   */
  async getState(
    config: RunnableConfig,
    options?: GetStateOptions
  ): Promise<StateSnapshot> {
    const checkpointer =
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] ?? this.checkpointer;
    if (!checkpointer) {
      throw new GraphValueError("No checkpointer set", {
        lc_error_code: "MISSING_CHECKPOINTER",
      });
    }

    const checkpointNamespace: string =
      config.configurable?.checkpoint_ns ?? "";
    if (
      checkpointNamespace !== "" &&
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] === undefined
    ) {
      // remove task_ids from checkpoint_ns
      const recastNamespace = recastCheckpointNamespace(checkpointNamespace);
      for await (const [name, subgraph] of this.getSubgraphsAsync(
        recastNamespace,
        true
      )) {
        if (name === recastNamespace) {
          return await subgraph.getState(
            patchConfigurable(config, {
              [CONFIG_KEY_CHECKPOINTER]: checkpointer,
            }),
            { subgraphs: options?.subgraphs }
          );
        }
      }
      throw new Error(
        `Subgraph with namespace "${recastNamespace}" not found.`
      );
    }

    const mergedConfig = mergeConfigs(this.config, config);
    const saved = await checkpointer.getTuple(config);
    const snapshot = await this._prepareStateSnapshot({
      config: mergedConfig,
      saved,
      subgraphCheckpointer: options?.subgraphs ? checkpointer : undefined,
      applyPendingWrites: !config.configurable?.checkpoint_id,
    });
    return snapshot;
  }

  /**
   * Gets the history of graph states.
   * Requires a checkpointer to be configured.
   * Useful for:
   * - Debugging execution history
   * - Implementing time travel
   * - Analyzing graph behavior
   *
   * @param config - Configuration for retrieving the history
   * @param options - Options for filtering the history
   * @returns An async iterator of state snapshots
   * @throws {Error} If no checkpointer is configured
   */
  async *getStateHistory(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncIterableIterator<StateSnapshot> {
    const checkpointer: BaseCheckpointSaver =
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] ?? this.checkpointer;
    if (!checkpointer) {
      throw new GraphValueError("No checkpointer set", {
        lc_error_code: "MISSING_CHECKPOINTER",
      });
    }

    const checkpointNamespace: string =
      config.configurable?.checkpoint_ns ?? "";
    if (
      checkpointNamespace !== "" &&
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] === undefined
    ) {
      const recastNamespace = recastCheckpointNamespace(checkpointNamespace);

      // find the subgraph with the matching name
      for await (const [name, pregel] of this.getSubgraphsAsync(
        recastNamespace,
        true
      )) {
        if (name === recastNamespace) {
          yield* pregel.getStateHistory(
            patchConfigurable(config, {
              [CONFIG_KEY_CHECKPOINTER]: checkpointer,
            }),
            options
          );
          return;
        }
      }
      throw new Error(
        `Subgraph with namespace "${recastNamespace}" not found.`
      );
    }

    const mergedConfig = mergeConfigs(this.config, config, {
      configurable: { checkpoint_ns: checkpointNamespace },
    });

    for await (const checkpointTuple of checkpointer.list(
      mergedConfig,
      options
    )) {
      yield this._prepareStateSnapshot({
        config: checkpointTuple.config,
        saved: checkpointTuple,
      });
    }
  }

  /**
   * Apply updates to the graph state in bulk.
   * Requires a checkpointer to be configured.
   *
   * This method is useful for recreating a thread
   * from a list of updates, especially if a checkpoint
   * is created as a result of multiple tasks.
   *
   * @internal The API might change in the future.
   *
   * @param startConfig - Configuration for the update
   * @param updates - The list of updates to apply to graph state
   * @returns Updated configuration
   * @throws {GraphValueError} If no checkpointer is configured
   * @throws {InvalidUpdateError} If the update cannot be attributed to a node or an update can be only applied in sequence.
   */
  async bulkUpdateState(
    startConfig: LangGraphRunnableConfig,
    supersteps: Array<{
      updates: Array<{
        values?: Record<string, unknown> | unknown;
        asNode?: keyof Nodes | string;
      }>;
    }>
  ): Promise<RunnableConfig> {
    const checkpointer: BaseCheckpointSaver | undefined =
      startConfig.configurable?.[CONFIG_KEY_CHECKPOINTER] ?? this.checkpointer;
    if (!checkpointer) {
      throw new GraphValueError("No checkpointer set", {
        lc_error_code: "MISSING_CHECKPOINTER",
      });
    }
    if (supersteps.length === 0) {
      throw new Error("No supersteps provided");
    }

    if (supersteps.some((s) => s.updates.length === 0)) {
      throw new Error("No updates provided");
    }

    // delegate to subgraph
    const checkpointNamespace: string =
      startConfig.configurable?.checkpoint_ns ?? "";
    if (
      checkpointNamespace !== "" &&
      startConfig.configurable?.[CONFIG_KEY_CHECKPOINTER] === undefined
    ) {
      // remove task_ids from checkpoint_ns
      const recastNamespace = recastCheckpointNamespace(checkpointNamespace);
      // find the subgraph with the matching name
      // eslint-disable-next-line no-unreachable-loop
      for await (const [, pregel] of this.getSubgraphsAsync(
        recastNamespace,
        true
      )) {
        return await pregel.bulkUpdateState(
          patchConfigurable(startConfig, {
            [CONFIG_KEY_CHECKPOINTER]: checkpointer,
          }),
          supersteps
        );
      }
      throw new Error(`Subgraph "${recastNamespace}" not found`);
    }

    const updateSuperStep = async (
      inputConfig: LangGraphRunnableConfig,
      updates: {
        values?: Record<string, unknown> | unknown;
        asNode?: keyof Nodes | string;
        taskId?: string;
      }[]
    ) => {
      // get last checkpoint
      const config = this.config
        ? mergeConfigs(this.config, inputConfig)
        : inputConfig;
      const saved = await checkpointer.getTuple(config);
      const checkpoint =
        saved !== undefined
          ? copyCheckpoint(saved.checkpoint)
          : emptyCheckpoint();
      const checkpointPreviousVersions = {
        ...saved?.checkpoint.channel_versions,
      };
      const step = saved?.metadata?.step ?? -1;

      // merge configurable fields with previous checkpoint config
      let checkpointConfig = patchConfigurable(config, {
        checkpoint_ns: config.configurable?.checkpoint_ns ?? "",
      });
      let checkpointMetadata = config.metadata ?? {};
      if (saved?.config.configurable) {
        checkpointConfig = patchConfigurable(config, saved.config.configurable);
        checkpointMetadata = {
          ...saved.metadata,
          ...checkpointMetadata,
        };
      }

      // Find last node that updated the state, if not provided
      const { values, asNode } = updates[0];
      if (values == null && asNode === undefined) {
        if (updates.length > 1) {
          throw new InvalidUpdateError(
            `Cannot create empty checkpoint with multiple updates`
          );
        }

        const nextConfig = await checkpointer.put(
          checkpointConfig,
          createCheckpoint(checkpoint, undefined, step),
          {
            source: "update",
            step: step + 1,
            parents: saved?.metadata?.parents ?? {},
          },
          {}
        );
        return patchCheckpointMap(
          nextConfig,
          saved ? saved.metadata : undefined
        );
      }

      // update channels
      const channels = emptyChannels(
        this.channels as Record<string, BaseChannel>,
        checkpoint
      );

      if (values === null && asNode === END) {
        if (updates.length > 1) {
          throw new InvalidUpdateError(
            `Cannot apply multiple updates when clearing state`
          );
        }

        if (saved) {
          // tasks for this checkpoint
          const nextTasks = _prepareNextTasks(
            checkpoint,
            saved.pendingWrites || [],
            this.nodes,
            channels,
            saved.config,
            true,
            {
              step: (saved.metadata?.step ?? -1) + 1,
              checkpointer,
              store: this.store,
            }
          );

          // apply null writes
          const nullWrites = (saved.pendingWrites || [])
            .filter((w) => w[0] === NULL_TASK_ID)
            .map((w) => w.slice(1)) as PendingWrite<string>[];
          if (nullWrites.length > 0) {
            _applyWrites(
              checkpoint,
              channels,
              [
                {
                  name: INPUT,
                  writes: nullWrites,
                  triggers: [],
                },
              ],
              checkpointer.getNextVersion.bind(checkpointer),
              this.triggerToNodes
            );
          }
          // apply writes from tasks that already ran
          for (const [taskId, k, v] of saved.pendingWrites || []) {
            if ([ERROR, INTERRUPT, SCHEDULED].includes(k)) {
              continue;
            }
            if (!(taskId in nextTasks)) {
              continue;
            }
            nextTasks[taskId].writes.push([k, v]);
          }
          // clear all current tasks
          _applyWrites(
            checkpoint,
            channels,
            Object.values(nextTasks) as WritesProtocol<string>[],
            checkpointer.getNextVersion.bind(checkpointer),
            this.triggerToNodes
          );
        }
        // save checkpoint
        const nextConfig = await checkpointer.put(
          checkpointConfig,
          createCheckpoint(checkpoint, channels, step),
          {
            ...checkpointMetadata,
            source: "update",
            step: step + 1,
            parents: saved?.metadata?.parents ?? {},
          },
          getNewChannelVersions(
            checkpointPreviousVersions,
            checkpoint.channel_versions
          )
        );
        return patchCheckpointMap(
          nextConfig,
          saved ? saved.metadata : undefined
        );
      }

      if (asNode === COPY) {
        if (updates.length > 1) {
          throw new InvalidUpdateError(
            `Cannot copy checkpoint with multiple updates`
          );
        }

        if (saved == null) {
          throw new InvalidUpdateError(`Cannot copy a non-existent checkpoint`);
        }

        const isCopyWithUpdates = (
          values: unknown
        ): values is [values: unknown, asNode: string][] => {
          if (!Array.isArray(values)) return false;
          if (values.length === 0) return false;
          return values.every((v) => Array.isArray(v) && v.length === 2);
        };

        const nextCheckpoint = createCheckpoint(checkpoint, undefined, step);
        const nextConfig = await checkpointer.put(
          saved.parentConfig ??
            patchConfigurable(saved.config, { checkpoint_id: undefined }),
          nextCheckpoint,
          {
            source: "fork",
            step: step + 1,
            parents: saved.metadata?.parents ?? {},
          },
          {}
        );

        // We want to both clone a checkpoint and update state in one go.
        // Reuse the same task ID if possible.
        if (isCopyWithUpdates(values)) {
          // figure out the task IDs for the next update checkpoint
          const nextTasks = _prepareNextTasks(
            nextCheckpoint,
            saved.pendingWrites,
            this.nodes,
            channels,
            nextConfig,
            false,
            { step: step + 2 }
          );

          const tasksGroupBy = Object.values(nextTasks).reduce<
            Record<string, { id: string }[]>
          >((acc, { name, id }) => {
            acc[name] ??= [];
            acc[name].push({ id });
            return acc;
          }, {});

          const userGroupBy = values.reduce<
            Record<
              string,
              { values: unknown; asNode: string; taskId?: string }[]
            >
          >((acc, item) => {
            const [values, asNode] = item;
            acc[asNode] ??= [];

            const targetIdx = acc[asNode].length;
            const taskId = tasksGroupBy[asNode]?.[targetIdx]?.id;
            acc[asNode].push({ values, asNode, taskId });

            return acc;
          }, {});

          return updateSuperStep(
            patchCheckpointMap(nextConfig, saved.metadata),
            Object.values(userGroupBy).flat()
          );
        }

        return patchCheckpointMap(nextConfig, saved.metadata);
      }

      if (asNode === INPUT) {
        if (updates.length > 1) {
          throw new InvalidUpdateError(
            `Cannot apply multiple updates when updating as input`
          );
        }

        const inputWrites = await gatherIterator(
          mapInput(this.inputChannels, values)
        );
        if (inputWrites.length === 0) {
          throw new InvalidUpdateError(
            `Received no input writes for ${JSON.stringify(
              this.inputChannels,
              null,
              2
            )}`
          );
        }

        // apply to checkpoint
        _applyWrites(
          checkpoint,
          channels,
          [
            {
              name: INPUT,
              writes: inputWrites as PendingWrite[],
              triggers: [],
            },
          ],
          checkpointer.getNextVersion.bind(this.checkpointer),
          this.triggerToNodes
        );

        // apply input write to channels
        const nextStep =
          saved?.metadata?.step != null ? saved.metadata.step + 1 : -1;
        const nextConfig = await checkpointer.put(
          checkpointConfig,
          createCheckpoint(checkpoint, channels, nextStep),
          {
            source: "input",
            step: nextStep,
            parents: saved?.metadata?.parents ?? {},
          },
          getNewChannelVersions(
            checkpointPreviousVersions,
            checkpoint.channel_versions
          )
        );

        // Store the writes
        await checkpointer.putWrites(
          nextConfig,
          inputWrites as PendingWrite[],
          uuid5(INPUT, checkpoint.id)
        );

        return patchCheckpointMap(
          nextConfig,
          saved ? saved.metadata : undefined
        );
      }

      // apply pending writes, if not on specific checkpoint
      if (
        config.configurable?.checkpoint_id === undefined &&
        saved?.pendingWrites !== undefined &&
        saved.pendingWrites.length > 0
      ) {
        // tasks for this checkpoint
        const nextTasks = _prepareNextTasks(
          checkpoint,
          saved.pendingWrites,
          this.nodes,
          channels,
          saved.config,
          true,
          {
            store: this.store,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            checkpointer: this.checkpointer as any,
            step: (saved.metadata?.step ?? -1) + 1,
          }
        );
        // apply null writes
        const nullWrites = (saved.pendingWrites ?? [])
          .filter((w) => w[0] === NULL_TASK_ID)
          .map((w) => w.slice(1)) as PendingWrite<string>[];
        if (nullWrites.length > 0) {
          _applyWrites(
            saved.checkpoint,
            channels,
            [{ name: INPUT, writes: nullWrites, triggers: [] }],
            undefined,
            this.triggerToNodes
          );
        }
        // apply writes
        for (const [tid, k, v] of saved.pendingWrites) {
          if (
            [ERROR, INTERRUPT, SCHEDULED].includes(k) ||
            nextTasks[tid] === undefined
          ) {
            continue;
          }
          nextTasks[tid].writes.push([k, v]);
        }
        const tasks = Object.values(nextTasks).filter((task) => {
          return task.writes.length > 0;
        });
        if (tasks.length > 0) {
          _applyWrites(
            checkpoint,
            channels,
            tasks as WritesProtocol[],
            undefined,
            this.triggerToNodes
          );
        }
      }
      const nonNullVersion = Object.values(checkpoint.versions_seen)
        .map((seenVersions) => {
          return Object.values(seenVersions);
        })
        .flat()
        .find((v) => !!v);

      const validUpdates: Array<{
        values: Record<string, unknown> | unknown;
        asNode: keyof Nodes | string;
        taskId?: string;
      }> = [];

      if (updates.length === 1) {
        // eslint-disable-next-line prefer-const
        let { values, asNode, taskId } = updates[0];
        if (asNode === undefined && Object.keys(this.nodes).length === 1) {
          // if only one node, use it
          [asNode] = Object.keys(this.nodes);
        } else if (asNode === undefined && nonNullVersion === undefined) {
          if (
            typeof this.inputChannels === "string" &&
            this.nodes[this.inputChannels] !== undefined
          ) {
            asNode = this.inputChannels;
          }
        } else if (asNode === undefined) {
          const lastSeenByNode = Object.entries(checkpoint.versions_seen)
            .map(([n, seen]) => {
              return Object.values(seen).map((v) => {
                return [v, n] as const;
              });
            })
            .flat()
            .filter(([_, v]) => v !== INTERRUPT)
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

        validUpdates.push({ values, asNode, taskId });
      } else {
        for (const { asNode, values, taskId } of updates) {
          if (asNode == null) {
            throw new InvalidUpdateError(
              `"asNode" is required when applying multiple updates`
            );
          }

          validUpdates.push({ values, asNode, taskId });
        }
      }

      const tasks: PregelExecutableTask<keyof Nodes, keyof Channels>[] = [];
      for (const { asNode, values, taskId } of validUpdates) {
        if (this.nodes[asNode] === undefined) {
          throw new InvalidUpdateError(
            `Node "${asNode.toString()}" does not exist`
          );
        }

        // run all writers of the chosen node
        const writers = this.nodes[asNode].getWriters();
        if (!writers.length) {
          throw new InvalidUpdateError(
            `No writers found for node "${asNode.toString()}"`
          );
        }
        tasks.push({
          name: asNode,
          input: values,
          proc:
            writers.length > 1
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                RunnableSequence.from(writers as any, {
                  omitSequenceTags: true,
                })
              : writers[0],
          writes: [],
          triggers: [INTERRUPT],
          id: taskId ?? uuid5(INTERRUPT, checkpoint.id),
          writers: [],
        });
      }

      for (const task of tasks) {
        // execute task
        await task.proc.invoke(
          task.input,
          patchConfig<LangGraphRunnableConfig>(
            {
              ...config,
              store: config?.store ?? this.store,
            },
            {
              runName: config.runName ?? `${this.getName()}UpdateState`,
              configurable: {
                [CONFIG_KEY_SEND]: (items: [keyof Channels, unknown][]) =>
                  task.writes.push(...items),
                [CONFIG_KEY_READ]: (
                  select_: Array<keyof Channels> | keyof Channels,
                  fresh_: boolean = false
                ) =>
                  _localRead(
                    checkpoint,
                    channels,
                    // TODO: Why does keyof StrRecord allow number and symbol?
                    task as PregelExecutableTask<string, string>,
                    select_ as string | string[],
                    fresh_
                  ),
              },
            }
          )
        );
      }

      for (const task of tasks) {
        // channel writes are saved to current checkpoint
        const channelWrites = task.writes.filter((w) => w[0] !== PUSH);
        // save task writes
        if (saved !== undefined && channelWrites.length > 0) {
          await checkpointer.putWrites(
            checkpointConfig,
            channelWrites as PendingWrite[],
            task.id
          );
        }
      }

      // apply to checkpoint
      // TODO: Why does keyof StrRecord allow number and symbol?
      _applyWrites(
        checkpoint,
        channels,
        tasks as PregelExecutableTask<string, string>[],
        checkpointer.getNextVersion.bind(this.checkpointer),
        this.triggerToNodes
      );

      const newVersions = getNewChannelVersions(
        checkpointPreviousVersions,
        checkpoint.channel_versions
      );
      const nextConfig = await checkpointer.put(
        checkpointConfig,
        createCheckpoint(checkpoint, channels, step + 1),
        {
          source: "update",
          step: step + 1,
          parents: saved?.metadata?.parents ?? {},
        },
        newVersions
      );

      for (const task of tasks) {
        // push writes are saved to next checkpoint
        const pushWrites = task.writes.filter((w) => w[0] === PUSH);

        if (pushWrites.length > 0) {
          await checkpointer.putWrites(
            nextConfig,
            pushWrites as PendingWrite[],
            task.id
          );
        }
      }

      return patchCheckpointMap(nextConfig, saved ? saved.metadata : undefined);
    };

    let currentConfig = startConfig;
    for (const { updates } of supersteps) {
      currentConfig = await updateSuperStep(currentConfig, updates);
    }

    return currentConfig;
  }

  /**
   * Updates the state of the graph with new values.
   * Requires a checkpointer to be configured.
   *
   * This method can be used for:
   * - Implementing human-in-the-loop workflows
   * - Modifying graph state during breakpoints
   * - Integrating external inputs into the graph
   *
   * @param inputConfig - Configuration for the update
   * @param values - The values to update the state with
   * @param asNode - Optional node name to attribute the update to
   * @returns Updated configuration
   * @throws {GraphValueError} If no checkpointer is configured
   * @throws {InvalidUpdateError} If the update cannot be attributed to a node
   */
  async updateState(
    inputConfig: LangGraphRunnableConfig,
    values: Record<string, unknown> | unknown,
    asNode?: keyof Nodes | string
  ): Promise<RunnableConfig> {
    return this.bulkUpdateState(inputConfig, [
      { updates: [{ values, asNode }] },
    ]);
  }

  /**
   * Gets the default values for various graph configuration options.
   * This is an internal method used to process and normalize configuration options.
   *
   * @param config - The input configuration options
   * @returns A tuple containing normalized values for:
   * - debug mode
   * - stream modes
   * - input keys
   * - output keys
   * - remaining config
   * - interrupt before nodes
   * - interrupt after nodes
   * - checkpointer
   * - store
   * - whether stream mode is single
   * - node cache
   * - whether checkpoint during is enabled
   * @internal
   */
  _defaults(config: PregelOptions<Nodes, Channels>): [
    boolean, // debug
    StreamMode[], // stream mode
    string | string[], // input keys
    string | string[], // output keys
    LangGraphRunnableConfig, // config without pregel keys
    All | string[], // interrupt before
    All | string[], // interrupt after
    BaseCheckpointSaver | undefined, // checkpointer
    BaseStore | undefined, // store
    boolean, // stream mode single
    BaseCache | undefined, // node cache
    Durability // durability
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
    let streamModeSingle = true;
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

    let defaultStreamMode: StreamMode[];
    if (streamMode !== undefined) {
      defaultStreamMode = Array.isArray(streamMode) ? streamMode : [streamMode];
      streamModeSingle = typeof streamMode === "string";
    } else {
      // if being called as a node in another graph, default to values mode
      // but don't overwrite `streamMode`if provided
      if (config.configurable?.[CONFIG_KEY_TASK_ID] !== undefined) {
        defaultStreamMode = ["values"];
      } else {
        defaultStreamMode = this.streamMode;
      }

      streamModeSingle = true;
    }

    let defaultCheckpointer: BaseCheckpointSaver | undefined;
    if (this.checkpointer === false) {
      defaultCheckpointer = undefined;
    } else if (
      config !== undefined &&
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] !== undefined
    ) {
      defaultCheckpointer = config.configurable[CONFIG_KEY_CHECKPOINTER];
    } else if (this.checkpointer === true) {
      throw new Error("checkpointer: true cannot be used for root graphs.");
    } else {
      defaultCheckpointer = this.checkpointer;
    }
    const defaultStore: BaseStore | undefined = config.store ?? this.store;
    const defaultCache: BaseCache | undefined = config.cache ?? this.cache;

    if (config.durability != null && config.checkpointDuring != null) {
      throw new Error(
        "Cannot use both `durability` and `checkpointDuring` at the same time."
      );
    }

    const checkpointDuringDurability: Durability | undefined = (() => {
      if (config.checkpointDuring == null) return undefined;
      if (config.checkpointDuring === false) return "exit";
      return "async";
    })();

    const defaultDurability: Durability =
      config.durability ??
      checkpointDuringDurability ??
      config?.configurable?.[CONFIG_KEY_DURABILITY] ??
      "async";

    return [
      defaultDebug,
      defaultStreamMode,
      defaultInputKeys as string | string[],
      defaultOutputKeys as string | string[],
      rest,
      defaultInterruptBefore as All | string[],
      defaultInterruptAfter as All | string[],
      defaultCheckpointer,
      defaultStore,
      streamModeSingle,
      defaultCache,
      defaultDurability,
    ];
  }

  /**
   * Streams the execution of the graph, emitting state updates as they occur.
   * This is the primary method for observing graph execution in real-time.
   *
   * Stream modes:
   * - "values": Emits complete state after each step
   * - "updates": Emits only state changes after each step
   * - "debug": Emits detailed debug information
   * - "messages": Emits messages from within nodes
   *
   * For more details, see the [Streaming how-to guides](../../how-tos/#streaming_1).
   *
   * @param input - The input to start graph execution with
   * @param options - Configuration options for streaming
   * @returns An async iterable stream of graph state updates
   */
  override async stream<
    TStreamMode extends StreamMode | StreamMode[] | undefined,
    TSubgraphs extends boolean,
    TEncoding extends "text/event-stream" | undefined
  >(
    input: InputType | CommandType | null,
    options?: Partial<
      PregelOptions<
        Nodes,
        Channels,
        ContextType,
        TStreamMode,
        TSubgraphs,
        TEncoding
      >
    >
  ): Promise<
    IterableReadableStream<
      StreamOutputMap<
        TStreamMode,
        TSubgraphs,
        StreamUpdatesType,
        StreamValuesType,
        keyof Nodes,
        NodeReturnType,
        StreamCustom,
        TEncoding
      >
    >
  > {
    // The ensureConfig method called internally defaults recursionLimit to 25 if not
    // passed directly in `options`.
    // There is currently no way in _streamIterator to determine whether this was
    // set by by ensureConfig or manually by the user, so we specify the bound value here
    // and override if it is passed as an explicit param in `options`.
    const abortController = new AbortController();

    const config = {
      recursionLimit: this.config?.recursionLimit,
      ...options,
      signal: combineAbortSignals(options?.signal, abortController.signal)
        .signal,
    };

    const stream = await super.stream(input, config);
    return new IterableReadableStreamWithAbortSignal(
      options?.encoding === "text/event-stream"
        ? toEventStream(stream)
        : stream,
      abortController
    );
  }

  /**
   * @inheritdoc
   */
  override streamEvents(
    input: InputType | CommandType | null,
    options: Partial<PregelOptions<Nodes, Channels, ContextType>> & {
      version: "v1" | "v2";
    },
    streamOptions?: StreamEventsOptions
  ): IterableReadableStream<StreamEvent>;

  override streamEvents(
    input: InputType | CommandType | null,
    options: Partial<PregelOptions<Nodes, Channels, ContextType>> & {
      version: "v1" | "v2";
      encoding: "text/event-stream";
    },
    streamOptions?: StreamEventsOptions
  ): IterableReadableStream<Uint8Array>;

  override streamEvents(
    input: InputType | CommandType | null,
    options: Partial<PregelOptions<Nodes, Channels, ContextType>> & {
      version: "v1" | "v2";
    },
    streamOptions?: StreamEventsOptions
  ): IterableReadableStream<StreamEvent | Uint8Array> {
    const abortController = new AbortController();

    const config = {
      recursionLimit: this.config?.recursionLimit,
      ...options,
      // Similar to `stream`, we need to pass the `config.callbacks` here,
      // otherwise the user-provided callback will get lost in `ensureLangGraphConfig`.

      // extend the callbacks with the ones from the config
      callbacks: combineCallbacks(this.config?.callbacks, options?.callbacks),
      signal: combineAbortSignals(options?.signal, abortController.signal)
        .signal,
    };

    return new IterableReadableStreamWithAbortSignal(
      super.streamEvents(input, config, streamOptions),
      abortController
    );
  }

  /**
   * Validates the input for the graph.
   * @param input - The input to validate
   * @returns The validated input
   * @internal
   */
  protected async _validateInput(input: PregelInputType) {
    return input;
  }

  /**
   * Validates the context options for the graph.
   * @param context - The context options to validate
   * @returns The validated context options
   * @internal
   */
  protected async _validateContext(
    context: Partial<LangGraphRunnableConfig["context"]>
  ): Promise<LangGraphRunnableConfig["context"]> {
    return context;
  }

  /**
   * Internal iterator used by stream() to generate state updates.
   * This method handles the core logic of graph execution and streaming.
   *
   * @param input - The input to start graph execution with
   * @param options - Configuration options for streaming
   * @returns AsyncGenerator yielding state updates
   * @internal
   */
  override async *_streamIterator(
    input: PregelInputType | Command,
    options?: Partial<PregelOptions<Nodes, Channels>>
  ): AsyncGenerator<PregelOutputType> {
    // Skip LGP encoding option is `streamEvents` is used
    const streamEncoding =
      "version" in (options ?? {}) ? undefined : options?.encoding ?? undefined;
    const streamSubgraphs = options?.subgraphs;
    const inputConfig = ensureLangGraphConfig(this.config, options);
    if (
      inputConfig.recursionLimit === undefined ||
      inputConfig.recursionLimit < 1
    ) {
      throw new Error(`Passed "recursionLimit" must be at least 1.`);
    }
    if (
      this.checkpointer !== undefined &&
      this.checkpointer !== false &&
      inputConfig.configurable === undefined
    ) {
      throw new Error(
        `Checkpointer requires one or more of the following "configurable" keys: "thread_id", "checkpoint_ns", "checkpoint_id"`
      );
    }

    const validInput = await this._validateInput(input);
    const { runId, ...restConfig } = inputConfig;
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
      store,
      streamModeSingle,
      cache,
      durability,
    ] = this._defaults(restConfig);

    // At entrypoint, `configurable` is an alias for `context`.
    if (typeof config.context !== "undefined") {
      config.context = await this._validateContext(config.context);
    } else {
      config.configurable = await this._validateContext(config.configurable);
    }

    const stream = new IterableReadableWritableStream({
      modes: new Set(streamMode),
    });

    // set up subgraph checkpointing
    if (this.checkpointer === true) {
      config.configurable ??= {};
      const ns: string = config.configurable[CONFIG_KEY_CHECKPOINT_NS] ?? "";
      config.configurable[CONFIG_KEY_CHECKPOINT_NS] = ns
        .split(CHECKPOINT_NAMESPACE_SEPARATOR)
        .map((part) => part.split(CHECKPOINT_NAMESPACE_END)[0])
        .join(CHECKPOINT_NAMESPACE_SEPARATOR);
    }

    // set up messages stream mode
    if (streamMode.includes("messages")) {
      const messageStreamer = new StreamMessagesHandler((chunk) =>
        stream.push(chunk)
      );
      const { callbacks } = config;
      if (callbacks === undefined) {
        config.callbacks = [messageStreamer];
      } else if (Array.isArray(callbacks)) {
        config.callbacks = callbacks.concat(messageStreamer);
      } else {
        const copiedCallbacks = callbacks.copy();
        copiedCallbacks.addHandler(messageStreamer, true);
        config.callbacks = copiedCallbacks;
      }
    }

    config.writer ??= (chunk: unknown) => {
      if (!streamMode.includes("custom")) return;
      const ns = (
        getConfig()?.configurable?.[CONFIG_KEY_CHECKPOINT_NS] as
          | string
          | undefined
      )
        ?.split(CHECKPOINT_NAMESPACE_SEPARATOR)
        .slice(0, -1);

      stream.push([ns ?? [], "custom", chunk]);
    };

    config.interrupt ??= (this.userInterrupt as typeof interrupt) ?? interrupt;

    const callbackManager = await getCallbackManagerForConfig(config);
    const runManager = await callbackManager?.handleChainStart(
      this.toJSON(), // chain
      _coerceToDict(input, "input"), // inputs
      runId, // run_id
      undefined, // run_type
      undefined, // tags
      undefined, // metadata
      config?.runName ?? this.getName() // run_name
    );

    const channelSpecs = getOnlyChannels(this.channels);
    let loop: PregelLoop | undefined;
    let loopError: unknown;

    /**
     * The PregelLoop will yield events from concurrent tasks as soon as they are
     * generated. Each task can push multiple events onto the stream in any order.
     *
     * We use a separate background method and stream here in order to yield events
     * from the loop to the main stream and therefore back to the user as soon as
     * they are available.
     */
    const createAndRunLoop = async () => {
      try {
        loop = await PregelLoop.initialize({
          input: validInput,
          config,
          checkpointer,
          nodes: this.nodes,
          channelSpecs,
          outputKeys,
          streamKeys: this.streamChannelsAsIs as string | string[],
          store,
          cache: cache as BaseCache<PendingWrite<string>[]>,
          stream,
          interruptAfter,
          interruptBefore,
          manager: runManager,
          debug: this.debug,
          triggerToNodes: this.triggerToNodes,
          durability,
        });

        const runner = new PregelRunner({
          loop,
          nodeFinished: config.configurable?.[CONFIG_KEY_NODE_FINISHED],
        });

        if (options?.subgraphs) {
          loop.config.configurable = {
            ...loop.config.configurable,
            [CONFIG_KEY_STREAM]: loop.stream,
          };
        }
        await this._runLoop({ loop, runner, debug, config });

        // wait for checkpoints to be persisted
        if (durability === "sync") {
          await Promise.all(loop?.checkpointerPromises ?? []);
        }
      } catch (e) {
        loopError = e;
      } finally {
        try {
          // Call `.stop()` again incase it was not called in the loop, e.g due to an error.
          if (loop) {
            await loop.store?.stop();
            await loop.cache?.stop();
          }
          await Promise.all(loop?.checkpointerPromises ?? []);
        } catch (e) {
          loopError = loopError ?? e;
        }
        if (loopError) {
          // "Causes any future interactions with the associated stream to error".
          // Wraps ReadableStreamDefaultController#error:
          // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultController/error
          stream.error(loopError);
        } else {
          // Will end the iterator outside of this method,
          // keeping previously enqueued chunks.
          // Wraps ReadableStreamDefaultController#close:
          // https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultController/close
          stream.close();
        }
      }
    };
    const runLoopPromise = createAndRunLoop();

    try {
      for await (const chunk of stream) {
        if (chunk === undefined) {
          throw new Error("Data structure error.");
        }
        const [namespace, mode, payload] = chunk;
        if (streamMode.includes(mode)) {
          if (streamEncoding === "text/event-stream") {
            if (streamSubgraphs) {
              yield [namespace, mode, payload];
            } else {
              yield [null, mode, payload];
            }
            continue;
          }
          if (streamSubgraphs && !streamModeSingle) {
            yield [namespace, mode, payload];
          } else if (!streamModeSingle) {
            yield [mode, payload];
          } else if (streamSubgraphs) {
            yield [namespace, payload];
          } else {
            yield payload;
          }
        }
      }
    } catch (e) {
      await runManager?.handleChainError(loopError);
      throw e;
    } finally {
      await runLoopPromise;
    }
    await runManager?.handleChainEnd(
      loop?.output ?? {},
      runId, // run_id
      undefined, // run_type
      undefined, // tags
      undefined // metadata
    );
  }

  /**
   * Run the graph with a single input and config.
   * @param input The input to the graph.
   * @param options The configuration to use for the run.
   */
  override async invoke(
    input: InputType | CommandType | null,
    options?: Partial<
      Omit<PregelOptions<Nodes, Channels, ContextType>, "encoding">
    >
  ): Promise<OutputType> {
    const streamMode = options?.streamMode ?? "values";
    const config = {
      ...options,
      outputKeys: options?.outputKeys ?? this.outputChannels,
      streamMode,
      encoding: undefined,
    };
    const chunks = [];
    const stream = await this.stream(input, config);
    const interruptChunks: Interrupt[][] = [];

    let latest: OutputType | undefined;

    for await (const chunk of stream) {
      if (streamMode === "values") {
        if (isInterrupted(chunk)) {
          interruptChunks.push(chunk[INTERRUPT]);
        } else {
          latest = chunk as OutputType;
        }
      } else {
        chunks.push(chunk);
      }
    }

    if (streamMode === "values") {
      if (interruptChunks.length > 0) {
        const interrupts = interruptChunks.flat(1);
        if (latest == null) return { [INTERRUPT]: interrupts } as OutputType;
        if (typeof latest === "object") {
          return { ...latest, [INTERRUPT]: interrupts };
        }
      }

      return latest as OutputType;
    }
    return chunks as OutputType;
  }

  private async _runLoop(params: {
    loop: PregelLoop;
    runner: PregelRunner;
    config: RunnableConfig;
    debug: boolean;
  }): Promise<void> {
    const { loop, runner, debug, config } = params;
    let tickError;
    try {
      while (
        await loop.tick({ inputKeys: this.inputChannels as string | string[] })
      ) {
        for (const { task } of await loop._matchCachedWrites()) {
          loop._outputWrites(task.id, task.writes, true);
        }

        if (debug) {
          printStepCheckpoint(
            loop.checkpointMetadata.step,
            loop.channels,
            this.streamChannelsList as string[]
          );
        }
        if (debug) {
          printStepTasks(loop.step, Object.values(loop.tasks));
        }
        await runner.tick({
          timeout: this.stepTimeout,
          retryPolicy: this.retryPolicy,
          onStepWrite: (step, writes) => {
            if (debug) {
              printStepWrites(
                step,
                writes,
                this.streamChannelsList as string[]
              );
            }
          },
          maxConcurrency: config.maxConcurrency,
          signal: config.signal,
        });
      }
      if (loop.status === "out_of_steps") {
        throw new GraphRecursionError(
          [
            `Recursion limit of ${config.recursionLimit} reached`,
            "without hitting a stop condition. You can increase the",
            `limit by setting the "recursionLimit" config key.`,
          ].join(" "),
          {
            lc_error_code: "GRAPH_RECURSION_LIMIT",
          }
        );
      }
    } catch (e) {
      tickError = e as Error;
      const suppress = await loop.finishAndHandleError(tickError);
      if (!suppress) {
        throw e;
      }
    } finally {
      if (tickError === undefined) {
        await loop.finishAndHandleError();
      }
    }
  }

  async clearCache(): Promise<void> {
    await this.cache?.clear([]);
  }
}
