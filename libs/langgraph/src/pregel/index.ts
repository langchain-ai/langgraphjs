/* eslint-disable no-param-reassign */
import {
  Runnable,
  RunnableConfig,
  RunnableFunc,
  RunnableSequence,
  getCallbackManagerForConfig,
  mergeConfigs,
  patchConfig,
  _coerceToRunnable,
  RunnableLike,
} from "@langchain/core/runnables";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import {
  All,
  BaseCheckpointSaver,
  BaseStore,
  CheckpointListOptions,
  CheckpointTuple,
  compareChannelVersions,
  copyCheckpoint,
  emptyCheckpoint,
  PendingWrite,
  SCHEDULED,
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
  ERROR,
  INTERRUPT,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CHECKPOINT_NAMESPACE_END,
  CONFIG_KEY_STREAM,
  CONFIG_KEY_TASK_ID,
  Command,
  NULL_TASK_ID,
  INPUT,
  PUSH,
} from "../constants.js";
import {
  PregelExecutableTask,
  PregelInterface,
  PregelParams,
  StateSnapshot,
  StreamMode,
  PregelInputType,
  PregelOutputType,
  PregelOptions,
  SingleChannelSubscriptionOptions,
  MultipleChannelSubscriptionOptions,
  GetStateOptions,
} from "./types.js";
import {
  GraphRecursionError,
  GraphValueError,
  InvalidUpdateError,
} from "../errors.js";
import {
  _prepareNextTasks,
  _localRead,
  _applyWrites,
  StrRecord,
  WritesProtocol,
} from "./algo.js";
import {
  _coerceToDict,
  getNewChannelVersions,
  patchCheckpointMap,
  RetryPolicy,
} from "./utils/index.js";
import { findSubgraphPregel } from "./utils/subgraph.js";
import { PregelLoop } from "./loop.js";
import {
  ChannelKeyPlaceholder,
  isConfiguredManagedValue,
  ManagedValue,
  ManagedValueMapping,
  NoopManagedValue,
  type ManagedValueSpec,
} from "../managed/base.js";
import { gatherIterator, patchConfigurable } from "../utils.js";
import {
  ensureLangGraphConfig,
  recastCheckpointNamespace,
} from "./utils/config.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
import { StreamMessagesHandler } from "./messages.js";
import { PregelRunner } from "./runner.js";
import { IterableReadableWritableStream } from "./stream.js";

type WriteValue = Runnable | RunnableFunc<unknown, unknown> | unknown;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

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

export type { PregelInputType, PregelOutputType, PregelOptions };

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
 * @typeParam ConfigurableFieldType - Type of configurable fields that can be passed to the graph
 * @typeParam InputType - Type of input values accepted by the graph
 * @typeParam OutputType - Type of output values produced by the graph
 */
export class Pregel<
    Nodes extends StrRecord<string, PregelNode>,
    Channels extends StrRecord<string, BaseChannel | ManagedValueSpec>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConfigurableFieldType extends Record<string, any> = StrRecord<string, any>,
    InputType = PregelInputType,
    OutputType = PregelOutputType
  >
  extends Runnable<
    InputType | Command | null,
    OutputType,
    PregelOptions<Nodes, Channels, ConfigurableFieldType>
  >
  implements
    PregelInterface<Nodes, Channels, ConfigurableFieldType>,
    PregelParams<Nodes, Channels>
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
  checkpointer?: BaseCheckpointSaver | false;

  /** Optional retry policy for handling failures in node execution */
  retryPolicy?: RetryPolicy;

  /** The default configuration for graph execution, can be overridden on a per-invocation basis */
  config?: LangGraphRunnableConfig;

  /**
   * Optional long-term memory store for the graph, allows for persistance & retrieval of data across threads
   */
  store?: BaseStore;

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
    this.name = fields.name;

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
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore Remove ignore when we remove support for 0.2 versions of core
  override withConfig(config: RunnableConfig): typeof this {
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
   * @returns A snapshot of the graph state
   * @internal
   */
  protected async _prepareStateSnapshot({
    config,
    saved,
    subgraphCheckpointer,
  }: {
    config: RunnableConfig;
    saved?: CheckpointTuple;
    subgraphCheckpointer?: BaseCheckpointSaver;
  }): Promise<StateSnapshot> {
    if (saved === undefined) {
      return {
        values: {},
        next: [],
        config,
        tasks: [],
      };
    }
    // Pass `skipManaged: true` as managed values should not be returned in get state calls.
    const { managed } = await this.prepareSpecs(config, { skipManaged: true });

    const channels = emptyChannels(
      this.channels as Record<string, BaseChannel>,
      saved.checkpoint
    );

    const nextTasks = Object.values(
      _prepareNextTasks(
        saved.checkpoint,
        saved.pendingWrites,
        this.nodes,
        channels,
        managed,
        saved.config,
        false,
        { step: (saved.metadata?.step ?? -1) + 1 }
      )
    );
    const subgraphs = await gatherIterator(this.getSubgraphsAsync());
    const parentNamespace = saved.config.configurable?.checkpoint_ns ?? "";
    const taskStates: Record<string, RunnableConfig | StateSnapshot> = {};
    for (const task of nextTasks) {
      const matchingSubgraph = subgraphs.find(([name]) => name === task.name);
      if (!matchingSubgraph) {
        continue;
      }
      // assemble checkpoint_ns for this task
      let taskNs = `${task.name}${CHECKPOINT_NAMESPACE_END}${task.id}`;
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
        const config: RunnableConfig = {
          configurable: {
            [CONFIG_KEY_CHECKPOINTER]: subgraphCheckpointer,
            thread_id: saved.config.configurable?.thread_id,
            checkpoint_ns: taskNs,
          },
        };
        taskStates[task.id] = await matchingSubgraph[1].getState(config, {
          subgraphs: true,
        });
      }
    }
    // apply pending writes
    const nullWrites = (saved.pendingWrites ?? [])
      .filter((w) => w[0] === NULL_TASK_ID)
      .map((w) => w.slice(1)) as PendingWrite<string>[];
    if (nullWrites.length > 0) {
      _applyWrites(saved.checkpoint, channels, [
        {
          name: INPUT,
          writes: nullWrites,
          triggers: [],
        },
      ]);
    }
    // assemble the state snapshot
    return {
      values: readChannels(
        channels,
        this.streamChannelsAsIs as string | string[]
      ),
      next: nextTasks.map((task) => task.name),
      tasks: tasksWithWrites(nextTasks, saved?.pendingWrites ?? [], taskStates),
      metadata: saved.metadata,
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
      throw new GraphValueError("No checkpointer set");
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
      throw new Error("No checkpointer set");
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
    const checkpointer: BaseCheckpointSaver | undefined =
      inputConfig.configurable?.[CONFIG_KEY_CHECKPOINTER] ?? this.checkpointer;
    if (!checkpointer) {
      throw new GraphValueError("No checkpointer set");
    }
    // delegate to subgraph
    const checkpointNamespace: string =
      inputConfig.configurable?.checkpoint_ns ?? "";
    if (
      checkpointNamespace !== "" &&
      inputConfig.configurable?.[CONFIG_KEY_CHECKPOINTER] === undefined
    ) {
      // remove task_ids from checkpoint_ns
      const recastNamespace = recastCheckpointNamespace(checkpointNamespace);
      // find the subgraph with the matching name
      // eslint-disable-next-line no-unreachable-loop
      for await (const [, pregel] of this.getSubgraphsAsync(
        recastNamespace,
        true
      )) {
        return await pregel.updateState(
          patchConfigurable(inputConfig, {
            [CONFIG_KEY_CHECKPOINTER]: checkpointer,
          }),
          values,
          asNode
        );
      }
      throw new Error(`Subgraph "${recastNamespace}" not found`);
    }
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
    if (values == null && asNode === undefined) {
      const nextConfig = await checkpointer.put(
        checkpointConfig,
        createCheckpoint(checkpoint, undefined, step),
        {
          source: "update",
          step: step + 1,
          writes: {},
          parents: saved?.metadata?.parents ?? {},
        },
        {}
      );
      return patchCheckpointMap(nextConfig, saved ? saved.metadata : undefined);
    }

    // update channels
    const channels = emptyChannels(
      this.channels as Record<string, BaseChannel>,
      checkpoint
    );

    // Pass `skipManaged: true` as managed values are not used/relevant in update state calls.
    const { managed } = await this.prepareSpecs(config, { skipManaged: true });

    if (values === null && asNode === "__end__") {
      if (saved) {
        // tasks for this checkpoint
        const nextTasks = _prepareNextTasks(
          checkpoint,
          saved.pendingWrites || [],
          this.nodes,
          channels,
          managed,
          saved.config,
          true,
          {
            step: (saved.metadata?.step ?? -1) + 1,
            checkpointer: this.checkpointer || undefined,
            store: this.store,
          }
        );

        // apply null writes
        const nullWrites = (saved.pendingWrites || [])
          .filter((w) => w[0] === NULL_TASK_ID)
          .map((w) => w.slice(1)) as PendingWrite<string>[];
        if (nullWrites.length > 0) {
          _applyWrites(saved.checkpoint, channels, [
            {
              name: INPUT,
              writes: nullWrites,
              triggers: [],
            },
          ]);
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
          Object.values(nextTasks) as WritesProtocol<string>[]
        );
      }
      // save checkpoint
      const nextConfig = await checkpointer.put(
        checkpointConfig,
        createCheckpoint(checkpoint, undefined, step),
        {
          ...checkpointMetadata,
          source: "update",
          step: step + 1,
          writes: {},
          parents: saved?.metadata?.parents ?? {},
        },
        {}
      );
      return patchCheckpointMap(nextConfig, saved ? saved.metadata : undefined);
    }
    if (values == null && asNode === "__copy__") {
      const nextConfig = await checkpointer.put(
        saved?.parentConfig ?? checkpointConfig,
        createCheckpoint(checkpoint, undefined, step),
        {
          source: "fork",
          step: step + 1,
          writes: {},
          parents: saved?.metadata?.parents ?? {},
        },
        {}
      );
      return patchCheckpointMap(nextConfig, saved ? saved.metadata : undefined);
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
        managed,
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
        _applyWrites(saved.checkpoint, channels, [
          {
            name: INPUT,
            writes: nullWrites,
            triggers: [],
          },
        ]);
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
        _applyWrites(checkpoint, channels, tasks as WritesProtocol[]);
      }
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
        writers.length > 1
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            RunnableSequence.from(writers as any, { omitSequenceTags: true })
          : writers[0],
      writes: [],
      triggers: [INTERRUPT],
      id: uuid5(INTERRUPT, checkpoint.id),
      writers: [],
    };

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
        }
      )
    );

    // save task writes
    // channel writes are saved to current checkpoint
    // push writes are saved to next checkpoint
    const [channelWrites, pushWrites] = [
      task.writes.filter((w) => w[0] !== PUSH),
      task.writes.filter((w) => w[0] === PUSH),
    ];
    // save task writes
    if (saved !== undefined && channelWrites.length > 0) {
      await checkpointer.putWrites(
        checkpointConfig,
        channelWrites as PendingWrite[],
        task.id
      );
    }

    // apply to checkpoint
    // TODO: Why does keyof StrRecord allow number and symbol?
    _applyWrites(
      checkpoint,
      channels,
      [task as PregelExecutableTask<string, string>],
      checkpointer.getNextVersion.bind(this.checkpointer)
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
        writes: { [asNode]: values },
        parents: saved?.metadata?.parents ?? {},
      },
      newVersions
    );

    if (pushWrites.length > 0) {
      await checkpointer.putWrites(
        nextConfig,
        pushWrites as PendingWrite[],
        task.id
      );
    }

    return patchCheckpointMap(nextConfig, saved ? saved.metadata : undefined);
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
    BaseCheckpointSaver | undefined,
    BaseStore | undefined,
    boolean
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
      defaultStreamMode = this.streamMode;
      streamModeSingle = true;
    }

    // if being called as a node in another graph, always use values mode
    if (config.configurable?.[CONFIG_KEY_TASK_ID] !== undefined) {
      defaultStreamMode = ["values"];
    }

    let defaultCheckpointer: BaseCheckpointSaver | undefined;
    if (this.checkpointer === false) {
      defaultCheckpointer = undefined;
    } else if (
      config !== undefined &&
      config.configurable?.[CONFIG_KEY_CHECKPOINTER] !== undefined
    ) {
      defaultCheckpointer = config.configurable[CONFIG_KEY_CHECKPOINTER];
    } else {
      defaultCheckpointer = this.checkpointer;
    }
    const defaultStore: BaseStore | undefined = config.store ?? this.store;

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
  override async stream(
    input: InputType | Command | null,
    options?: Partial<PregelOptions<Nodes, Channels, ConfigurableFieldType>>
  ): Promise<IterableReadableStream<PregelOutputType>> {
    // The ensureConfig method called internally defaults recursionLimit to 25 if not
    // passed directly in `options`.
    // There is currently no way in _streamIterator to determine whether this was
    // set by by ensureConfig or manually by the user, so we specify the bound value here
    // and override if it is passed as an explicit param in `options`.
    const config = {
      recursionLimit: this.config?.recursionLimit,
      ...options,
    };
    return super.stream(input, config);
  }

  /**
   * Prepares channel specifications and managed values for graph execution.
   * This is an internal method used to set up the graph's communication channels
   * and managed state before execution.
   *
   * @param config - Configuration for preparing specs
   * @param options - Additional options
   * @param options.skipManaged - Whether to skip initialization of managed values
   * @returns Object containing channel specs and managed value mapping
   * @internal
   */
  protected async prepareSpecs(
    config: RunnableConfig,
    options?: {
      skipManaged?: boolean;
    }
  ) {
    const configForManaged: LangGraphRunnableConfig = {
      ...config,
      store: this.store,
    };
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
    ] = this._defaults(restConfig);

    const stream = new IterableReadableWritableStream({
      modes: new Set(streamMode),
    });

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

    // setup custom stream mode
    if (streamMode.includes("custom")) {
      config.writer = (chunk: unknown) => stream.push([[], "custom", chunk]);
    }

    const callbackManager = await getCallbackManagerForConfig(config);
    const runManager = await callbackManager?.handleChainStart(
      this.toJSON(),
      _coerceToDict(input, "input"),
      runId,
      undefined,
      undefined,
      undefined,
      config?.runName ?? this.getName()
    );

    const { channelSpecs, managed } = await this.prepareSpecs(config);

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
          input,
          config,
          checkpointer,
          nodes: this.nodes,
          channelSpecs,
          managed,
          outputKeys,
          streamKeys: this.streamChannelsAsIs as string | string[],
          store,
          stream,
          interruptAfter,
          interruptBefore,
          manager: runManager,
          debug: this.debug,
        });

        const runner = new PregelRunner({
          loop,
          nodeFinished: config.configurable?.nodeFinished,
        });

        if (options?.subgraphs) {
          loop.config.configurable = {
            ...loop.config.configurable,
            [CONFIG_KEY_STREAM]: loop.stream,
          };
        }
        await this._runLoop({ loop, runner, debug, config });
      } catch (e) {
        loopError = e;
      } finally {
        try {
          // Call `.stop()` again incase it was not called in the loop, e.g due to an error.
          if (loop) {
            await loop.store?.stop();
          }
          await Promise.all([
            ...(loop?.checkpointerPromises ?? []),
            ...Array.from(managed.values()).map((mv) => mv.promises()),
          ]);
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
    await runManager?.handleChainEnd(loop?.output ?? {});
  }

  /**
   * Run the graph with a single input and config.
   * @param input The input to the graph.
   * @param options The configuration to use for the run.
   */
  override async invoke(
    input: InputType | Command | null,
    options?: Partial<PregelOptions<Nodes, Channels, ConfigurableFieldType>>
  ): Promise<OutputType> {
    const streamMode = options?.streamMode ?? "values";
    const config = {
      ...options,
      outputKeys: options?.outputKeys ?? this.outputChannels,
      streamMode,
    };
    const chunks = [];
    const stream = await this.stream(input, config);
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    if (streamMode === "values") {
      return chunks[chunks.length - 1];
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
        await loop.tick({
          inputKeys: this.inputChannels as string | string[],
        })
      ) {
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
}
