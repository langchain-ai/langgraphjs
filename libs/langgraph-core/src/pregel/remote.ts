import {
  Client,
  type Checkpoint,
  type ThreadState,
} from "@langchain/langgraph-sdk";
import {
  Graph as DrawableGraph,
  Node as DrawableNode,
} from "@langchain/core/runnables/graph";
import {
  mergeConfigs,
  Runnable,
  RunnableConfig,
} from "@langchain/core/runnables";
import {
  All,
  CheckpointListOptions,
  CheckpointMetadata,
} from "@langchain/langgraph-checkpoint";
import { StreamEvent } from "@langchain/core/tracers/log_stream";
import { IterableReadableStream } from "@langchain/core/utils/stream";
import { isBaseMessage } from "@langchain/core/messages";

import {
  BaseChannel,
  GraphInterrupt,
  LangGraphRunnableConfig,
  RemoteException,
} from "../web.js";
import { StrRecord } from "./algo.js";
import { PregelInputType, PregelOptions, PregelOutputType } from "./index.js";
import { PregelNode } from "./read.js";
import {
  PregelParams,
  PregelInterface,
  PregelTaskDescription,
  StateSnapshot,
  StreamMode,
} from "./types.js";
import {
  CHECKPOINT_NAMESPACE_SEPARATOR,
  CONFIG_KEY_STREAM,
  INTERRUPT,
  isCommand,
} from "../constants.js";

export type RemoteGraphParams = Omit<
  PregelParams<StrRecord<string, PregelNode>, StrRecord<string, BaseChannel>>,
  "channels" | "nodes" | "inputChannels" | "outputChannels"
> & {
  graphId: string;
  client?: Client;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  streamResumable?: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _serializeInputs = (obj: any): any => {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(_serializeInputs);
  }

  // Handle BaseMessage instances by converting them to a serializable format
  if (isBaseMessage(obj)) {
    const dict = obj.toDict();
    return {
      ...dict.data,
      role: obj.getType(),
    };
  }

  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key, _serializeInputs(value)])
  );
};

/**
 * Return a tuple of the final list of stream modes sent to the
 * remote graph and a boolean flag indicating if only one stream mode was
 * originally requested and whether stream mode 'updates'
 * was present in the original list of stream modes.
 *
 * 'updates' mode is always added to the list of stream modes so that interrupts
 * can be detected in the remote graph.
 */
const getStreamModes = (
  streamMode?: StreamMode | StreamMode[],
  defaultStreamMode: StreamMode = "updates"
) => {
  const updatedStreamModes: StreamMode[] = [];
  let reqUpdates = false;
  let reqSingle = true;

  if (
    streamMode !== undefined &&
    (typeof streamMode === "string" ||
      (Array.isArray(streamMode) && streamMode.length > 0))
  ) {
    reqSingle = typeof streamMode === "string";
    const mapped = Array.isArray(streamMode) ? streamMode : [streamMode];
    updatedStreamModes.push(...mapped);
  } else {
    updatedStreamModes.push(defaultStreamMode);
  }
  if (updatedStreamModes.includes("updates")) {
    reqUpdates = true;
  } else {
    updatedStreamModes.push("updates");
  }
  return {
    updatedStreamModes,
    reqUpdates,
    reqSingle,
  };
};

/**
 * The `RemoteGraph` class is a client implementation for calling remote
 * APIs that implement the LangGraph Server API specification.
 *
 * For example, the `RemoteGraph` class can be used to call APIs from deployments
 * on LangSmith Deployment.
 *
 * `RemoteGraph` behaves the same way as a `StateGraph` and can be used directly as
 * a node in another `StateGraph`.
 *
 * @example
 * ```ts
 * import { RemoteGraph } from "@langchain/langgraph/remote";
 *
 * // Can also pass a LangGraph SDK client instance directly
 * const remoteGraph = new RemoteGraph({
 *   graphId: process.env.LANGGRAPH_REMOTE_GRAPH_ID!,
 *   apiKey: process.env.LANGGRAPH_REMOTE_GRAPH_API_KEY,
 *   url: process.env.LANGGRAPH_REMOTE_GRAPH_API_URL,
 * });
 *
 * const input = {
 *   messages: [
 *     {
 *       role: "human",
 *       content: "Hello world!",
 *     },
 *   ],
 * };
 *
 * const config = {
 *   configurable: { thread_id: "threadId1" },
 * };
 *
 * await remoteGraph.invoke(input, config);
 * ```
 */
export class RemoteGraph<
    Nn extends StrRecord<string, PregelNode> = StrRecord<string, PregelNode>,
    Cc extends StrRecord<string, BaseChannel> = StrRecord<string, BaseChannel>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ContextType extends Record<string, any> = StrRecord<string, any>
  >
  extends Runnable<
    PregelInputType,
    PregelOutputType,
    PregelOptions<Nn, Cc, ContextType>
  >
  implements PregelInterface<Nn, Cc, ContextType>
{
  static lc_name() {
    return "RemoteGraph";
  }

  lc_namespace = ["langgraph", "pregel"];

  lg_is_pregel = true;

  config?: RunnableConfig;

  graphId: string;

  protected client: Client;

  protected interruptBefore?: Array<keyof Nn> | All;

  protected interruptAfter?: Array<keyof Nn> | All;

  protected streamResumable?: boolean;

  constructor(params: RemoteGraphParams) {
    super(params);

    this.graphId = params.graphId;
    this.client =
      params.client ??
      new Client({
        apiUrl: params.url,
        apiKey: params.apiKey,
        defaultHeaders: params.headers,
      });
    this.config = params.config;
    this.interruptBefore = params.interruptBefore;
    this.interruptAfter = params.interruptAfter;
    this.streamResumable = params.streamResumable;
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore Remove ignore when we remove support for 0.2 versions of core
  override withConfig(config: RunnableConfig): typeof this {
    const mergedConfig = mergeConfigs(this.config, config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (this.constructor as any)({ ...this, config: mergedConfig });
  }

  protected _sanitizeConfig(config: RunnableConfig) {
    const reservedConfigurableKeys = new Set([
      "callbacks",
      "checkpoint_map",
      "checkpoint_id",
      "checkpoint_ns",
    ]);

    const sanitizeObj = <T>(obj: T): T => {
      try {
        // This will only throw if we're trying to serialize a circular reference
        // or trying to serialize a BigInt...
        JSON.stringify(obj);
        return obj;
      } catch {
        const seen = new WeakSet();
        return JSON.parse(
          JSON.stringify(obj, (_, value) => {
            if (typeof value === "object" && value != null) {
              if (seen.has(value)) return "[Circular]";
              seen.add(value);
            }

            if (typeof value === "bigint") return value.toString();
            return value;
          })
        );
      }
    };

    // Remove non-JSON serializable fields from the config
    const sanitizedConfig = sanitizeObj(config);

    // Only include configurable keys that are not reserved and
    // not starting with "__pregel_" prefix
    const newConfigurable = Object.fromEntries(
      Object.entries(sanitizedConfig.configurable ?? {}).filter(
        ([k]) => !reservedConfigurableKeys.has(k) && !k.startsWith("__pregel_")
      )
    );

    return {
      tags: sanitizedConfig.tags ?? [],
      metadata: sanitizedConfig.metadata ?? {},
      configurable: newConfigurable,
      recursion_limit: sanitizedConfig.recursionLimit,
    };
  }

  protected _getConfig(checkpoint: Record<string, unknown>): RunnableConfig {
    return {
      configurable: {
        thread_id: checkpoint.thread_id,
        checkpoint_ns: checkpoint.checkpoint_ns,
        checkpoint_id: checkpoint.checkpoint_id,
        checkpoint_map: checkpoint.checkpoint_map ?? {},
      },
    };
  }

  protected _getCheckpoint(config?: RunnableConfig): Checkpoint | undefined {
    if (config?.configurable === undefined) {
      return undefined;
    }

    const checkpointKeys = [
      "thread_id",
      "checkpoint_ns",
      "checkpoint_id",
      "checkpoint_map",
    ] as const;

    const checkpoint = Object.fromEntries(
      checkpointKeys
        .map((key) => [key, config.configurable![key]])
        .filter(([_, value]) => value !== undefined)
    );

    return Object.keys(checkpoint).length > 0 ? checkpoint : undefined;
  }

  protected _createStateSnapshot(state: ThreadState): StateSnapshot {
    const tasks: PregelTaskDescription[] = state.tasks.map((task) => {
      return {
        id: task.id,
        name: task.name,
        error: task.error ? { message: task.error } : undefined,
        // TODO: remove in LangGraph.js 0.4
        interrupts: task.interrupts.map(({ id, ...rest }) => ({
          interrupt_id: id,
          ...rest,
        })),
        // eslint-disable-next-line no-nested-ternary
        state: task.state
          ? this._createStateSnapshot(task.state)
          : task.checkpoint
          ? { configurable: task.checkpoint }
          : undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result: (task as any).result,
      };
    });

    return {
      values: state.values,
      next: state.next ? [...state.next] : [],
      config: {
        configurable: {
          thread_id: state.checkpoint.thread_id,
          checkpoint_ns: state.checkpoint.checkpoint_ns,
          checkpoint_id: state.checkpoint.checkpoint_id,
          checkpoint_map: state.checkpoint.checkpoint_map ?? {},
        },
      },
      metadata: state.metadata
        ? (state.metadata as CheckpointMetadata)
        : undefined,
      createdAt: state.created_at ?? undefined,
      parentConfig: state.parent_checkpoint
        ? {
            configurable: {
              thread_id: state.parent_checkpoint.thread_id,
              checkpoint_ns: state.parent_checkpoint.checkpoint_ns,
              checkpoint_id: state.parent_checkpoint.checkpoint_id,
              checkpoint_map: state.parent_checkpoint.checkpoint_map ?? {},
            },
          }
        : undefined,
      tasks,
    };
  }

  override async invoke(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ContextType>>
  ): Promise<PregelOutputType> {
    let lastValue;
    const stream = await this.stream(input, {
      ...options,
      streamMode: "values",
    });
    for await (const chunk of stream) {
      lastValue = chunk;
    }
    return lastValue;
  }

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2";
    }
  ): IterableReadableStream<StreamEvent>;

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2";
      encoding: never;
    }
  ): IterableReadableStream<never>;

  override streamEvents(
    _input: PregelInputType,
    _options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2";
      encoding?: never;
    }
  ): IterableReadableStream<StreamEvent> {
    throw new Error("Not implemented.");
  }

  override async *_streamIterator(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ContextType>>
  ): AsyncGenerator<PregelOutputType> {
    const mergedConfig = mergeConfigs(this.config, options);
    const sanitizedConfig = this._sanitizeConfig(mergedConfig);

    const streamProtocolInstance = options?.configurable?.[CONFIG_KEY_STREAM];

    const streamSubgraphs =
      options?.subgraphs ?? streamProtocolInstance !== undefined;

    const interruptBefore = options?.interruptBefore ?? this.interruptBefore;
    const interruptAfter = options?.interruptAfter ?? this.interruptAfter;

    const { updatedStreamModes, reqSingle, reqUpdates } = getStreamModes(
      options?.streamMode
    );

    const extendedStreamModes = [
      ...new Set([
        ...updatedStreamModes,
        ...(streamProtocolInstance?.modes ?? new Set()),
      ]),
    ].map((mode) => {
      if (mode === "messages") return "messages-tuple";
      return mode;
    });

    let command;
    let serializedInput;
    if (isCommand(input)) {
      // TODO: Remove cast when SDK type fix gets merged
      command = input.toJSON() as Record<string, unknown>;
      serializedInput = undefined;
    } else {
      serializedInput = _serializeInputs(input);
    }

    for await (const chunk of this.client.runs.stream(
      sanitizedConfig.configurable.thread_id as string,
      this.graphId,
      {
        command,
        input: serializedInput,
        config: sanitizedConfig,
        streamMode: extendedStreamModes,
        interruptBefore: interruptBefore as string[],
        interruptAfter: interruptAfter as string[],
        streamSubgraphs,
        ifNotExists: "create",
        signal: mergedConfig.signal,
        streamResumable: this.streamResumable,
      }
    )) {
      let mode;
      let namespace: string[];
      if (chunk.event.includes(CHECKPOINT_NAMESPACE_SEPARATOR)) {
        const eventComponents = chunk.event.split(
          CHECKPOINT_NAMESPACE_SEPARATOR
        );
        // eslint-disable-next-line prefer-destructuring
        mode = eventComponents[0];
        namespace = eventComponents.slice(1);
      } else {
        mode = chunk.event;
        namespace = [];
      }
      const callerNamespace = options?.configurable?.checkpoint_ns;
      if (typeof callerNamespace === "string") {
        namespace = callerNamespace
          .split(CHECKPOINT_NAMESPACE_SEPARATOR)
          .concat(namespace);
      }
      if (
        streamProtocolInstance !== undefined &&
        streamProtocolInstance.modes?.has(chunk.event)
      ) {
        streamProtocolInstance.push([namespace, mode, chunk.data]);
      }
      if (chunk.event.startsWith("updates")) {
        if (
          typeof chunk.data === "object" &&
          chunk.data?.[INTERRUPT] !== undefined
        ) {
          throw new GraphInterrupt(chunk.data[INTERRUPT]);
        }
        if (!reqUpdates) {
          continue;
        }
      } else if (chunk.event?.startsWith("error")) {
        throw new RemoteException(
          typeof chunk.data === "string"
            ? chunk.data
            : JSON.stringify(chunk.data)
        );
      }
      if (
        !updatedStreamModes.includes(
          chunk.event.split(CHECKPOINT_NAMESPACE_SEPARATOR)[0] as StreamMode
        )
      ) {
        continue;
      }
      if (options?.subgraphs) {
        if (reqSingle) {
          yield [namespace, chunk.data];
        } else {
          yield [namespace, mode, chunk.data];
        }
      } else if (reqSingle) {
        yield chunk.data;
      } else {
        yield [mode, chunk.data];
      }
    }
  }

  async updateState(
    inputConfig: LangGraphRunnableConfig,
    values: Record<string, unknown>,
    asNode?: string
  ): Promise<RunnableConfig> {
    const mergedConfig = mergeConfigs(this.config, inputConfig);
    const response = await this.client.threads.updateState(
      mergedConfig.configurable?.thread_id,
      { values, asNode, checkpoint: this._getCheckpoint(mergedConfig) }
    );
    // TODO: Fix SDK typing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this._getConfig((response as any).checkpoint);
  }

  async *getStateHistory(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncIterableIterator<StateSnapshot> {
    const mergedConfig = mergeConfigs(this.config, config);
    const states = await this.client.threads.getHistory(
      mergedConfig.configurable?.thread_id,
      {
        limit: options?.limit ?? 10,
        // TODO: Fix type
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before: this._getCheckpoint(options?.before) as any,
        metadata: options?.filter,
        checkpoint: this._getCheckpoint(mergedConfig),
      }
    );
    for (const state of states) {
      yield this._createStateSnapshot(state);
    }
  }

  protected _getDrawableNodes(
    nodes: Array<{
      id: string | number;
      name?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data?: Record<string, any> | string;
      metadata?: unknown;
    }>
  ): Record<string, DrawableNode> {
    const nodesMap: Record<string, DrawableNode> = {};
    for (const node of nodes) {
      const nodeId = node.id;
      nodesMap[nodeId] = {
        id: nodeId.toString(),
        name: typeof node.data === "string" ? node.data : node.data?.name ?? "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (node.data as any) ?? {},
        metadata:
          typeof node.data !== "string" ? node.data?.metadata ?? {} : {},
      };
    }
    return nodesMap;
  }

  async getState(
    config: RunnableConfig,
    options?: { subgraphs?: boolean }
  ): Promise<StateSnapshot> {
    const mergedConfig = mergeConfigs(this.config, config);

    const state = await this.client.threads.getState(
      mergedConfig.configurable?.thread_id,
      this._getCheckpoint(mergedConfig),
      options
    );
    return this._createStateSnapshot(state);
  }

  /** @deprecated Use getGraphAsync instead. The async method will become the default in the next minor release. */
  override getGraph(
    _?: RunnableConfig & { xray?: boolean | number }
  ): DrawableGraph {
    throw new Error(
      `The synchronous "getGraph" is not supported for this graph. Call "getGraphAsync" instead.`
    );
  }

  /**
   * Returns a drawable representation of the computation graph.
   */
  async getGraphAsync(config?: RunnableConfig & { xray?: boolean | number }) {
    const graph = await this.client.assistants.getGraph(this.graphId, {
      xray: config?.xray,
    });
    return new DrawableGraph({
      nodes: this._getDrawableNodes(graph.nodes),
      edges: graph.edges,
    });
  }

  /** @deprecated Use getSubgraphsAsync instead. The async method will become the default in the next minor release. */
  getSubgraphs(): Generator<[string, PregelInterface<Nn, Cc, ContextType>]> {
    throw new Error(
      `The synchronous "getSubgraphs" method is not supported for this graph. Call "getSubgraphsAsync" instead.`
    );
  }

  async *getSubgraphsAsync(
    namespace?: string,
    recurse = false
  ): AsyncGenerator<[string, PregelInterface<Nn, Cc, ContextType>]> {
    const subgraphs = await this.client.assistants.getSubgraphs(this.graphId, {
      namespace,
      recurse,
    });

    for (const [ns, graphSchema] of Object.entries(subgraphs)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const remoteSubgraph = new (this.constructor as any)({
        ...this,
        graphId: graphSchema.graph_id,
      });
      yield [ns, remoteSubgraph];
    }
  }
}
