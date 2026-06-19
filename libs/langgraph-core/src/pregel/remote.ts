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
import { BaseMessage } from "@langchain/core/messages";

import {
  BaseChannel,
  GraphInterrupt,
  LangGraphRunnableConfig,
  RemoteException,
} from "../web.js";
import { StrRecord } from "./algo.js";
import { PregelInputType, PregelOptions, PregelOutputType } from "./index.js";
import { PregelNode } from "./read.js";
import { RemoteGraphRunStream } from "./remote-run-stream.js";
import { IterableReadableStreamWithAbortSignal } from "./stream.js";
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
import { propagateConfigurableToMetadata } from "./utils/config.js";
import type { ProtocolEvent } from "../stream/types.js";

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

type StreamEventsOptions = Parameters<Runnable["streamEvents"]>[2];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _serializeInputs = (obj: any): any => {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(_serializeInputs);
  }

  // Handle BaseMessage instances by converting them to a serializable format
  if (BaseMessage.isInstance(obj)) {
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

function protocolEventsToEventStream(run: AsyncIterable<ProtocolEvent>) {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of run) {
          const namespace = event.params.namespace;
          const eventName = namespace.length
            ? `${event.method}|${namespace.join("|")}`
            : event.method;
          controller.enqueue(
            encoder.encode(
              `event: ${eventName}\ndata: ${JSON.stringify(event.params.data ?? {})}\n\n`
            )
          );
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
    },
  });
}

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
  ContextType extends Record<string, any> = StrRecord<string, any>,
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

    const propagateMetadataDefaults = (obj: unknown) => {
      const seen = new WeakSet<object>();
      const visit = (value: unknown) => {
        if (typeof value !== "object" || value == null) {
          return;
        }
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
        const record = value as Record<string, unknown>;
        const configurable = record.configurable;
        if (
          typeof configurable === "object" &&
          configurable != null &&
          !Array.isArray(configurable)
        ) {
          const metadata =
            typeof record.metadata === "object" &&
            record.metadata != null &&
            !Array.isArray(record.metadata)
              ? (record.metadata as Record<string, unknown>)
              : undefined;
          record.metadata =
            propagateConfigurableToMetadata(
              configurable as Record<string, unknown>,
              metadata
            ) ?? record.metadata;
        }
        for (const nestedValue of Object.values(record)) {
          visit(nestedValue);
        }
      };
      visit(obj);
    };

    propagateMetadataDefaults(config);

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

  /**
   * Prepare config and thread ID for remote run API calls.
   *
   * `thread_id` is passed via the URL path, not in `config.configurable`, so the
   * server can accept a separate `context` payload for stateful runs.
   */
  #prepareRunRequest(mergedConfig: LangGraphRunnableConfig): {
    threadId: string | undefined;
    context: unknown;
    config: ReturnType<RemoteGraph["_sanitizeConfig"]>;
  } {
    const context = mergedConfig.context;
    const sanitizedConfig = this._sanitizeConfig(mergedConfig);
    const configurable = { ...sanitizedConfig.configurable };
    const threadId = configurable.thread_id as string | undefined;
    delete configurable.thread_id;

    return {
      threadId,
      context,
      config: {
        ...sanitizedConfig,
        configurable,
      },
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

  protected _checkpointToConfig(
    checkpoint?: Partial<Checkpoint> | null,
    fallbackConfig?: RunnableConfig
  ): RunnableConfig {
    const resolvedCheckpoint =
      checkpoint ?? this._getCheckpoint(fallbackConfig);
    if (resolvedCheckpoint == null) {
      return { configurable: {} };
    }

    const configurable: Record<string, unknown> = {};
    if (resolvedCheckpoint.thread_id !== undefined) {
      configurable.thread_id = resolvedCheckpoint.thread_id;
    }
    if (resolvedCheckpoint.checkpoint_ns !== undefined) {
      configurable.checkpoint_ns = resolvedCheckpoint.checkpoint_ns;
    }
    if (resolvedCheckpoint.checkpoint_id !== undefined) {
      configurable.checkpoint_id = resolvedCheckpoint.checkpoint_id;
    }

    const hasCheckpointFields =
      resolvedCheckpoint.checkpoint_ns !== undefined ||
      resolvedCheckpoint.checkpoint_id !== undefined ||
      resolvedCheckpoint.checkpoint_map !== undefined;
    if (hasCheckpointFields) {
      configurable.checkpoint_map = resolvedCheckpoint.checkpoint_map ?? {};
    }

    return { configurable };
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

  protected _createStateSnapshot(
    state: ThreadState,
    fallbackConfig?: RunnableConfig
  ): StateSnapshot {
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
          ? this._createStateSnapshot(
              task.state,
              task.checkpoint
                ? this._checkpointToConfig(task.checkpoint)
                : fallbackConfig
            )
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
      // TODO: Fix SDK typing. `ThreadState.checkpoint` is typed as non-null,
      // but deployments can return `null` (e.g. a thread that exists but has
      // not produced a checkpoint yet). See #2328.
      config: this._checkpointToConfig(
        state.checkpoint as Checkpoint | null,
        fallbackConfig
      ),
      metadata: state.metadata
        ? (state.metadata as CheckpointMetadata)
        : undefined,
      createdAt: state.created_at ?? undefined,
      parentConfig: state.parent_checkpoint
        ? this._checkpointToConfig(state.parent_checkpoint)
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
      version: "v3";
      encoding: "text/event-stream";
    }
  ): Promise<IterableReadableStream<Uint8Array>>;

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v3";
      encoding?: undefined;
    }
  ): Promise<RemoteGraphRunStream<PregelOutputType>>;

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2";
    },
    streamOptions?: StreamEventsOptions
  ): IterableReadableStream<StreamEvent>;

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2";
      encoding: "text/event-stream";
    },
    streamOptions?: StreamEventsOptions
  ): IterableReadableStream<Uint8Array>;

  override streamEvents(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v1" | "v2" | "v3";
      encoding?: "text/event-stream";
    },
    _streamOptions?: StreamEventsOptions
  ):
    | IterableReadableStream<StreamEvent | Uint8Array>
    | Promise<RemoteGraphRunStream<PregelOutputType>>
    | Promise<IterableReadableStream<Uint8Array>>
    | Promise<
        | RemoteGraphRunStream<PregelOutputType>
        | IterableReadableStream<Uint8Array>
      > {
    if (options.version === "v3") {
      return this._streamEventsV3(
        input,
        options as Partial<PregelOptions<Nn, Cc, ContextType>> & {
          version: "v3";
          encoding?: "text/event-stream";
        }
      );
    }
    throw new Error("Not implemented.");
  }

  protected _rejectV3Unsupported(
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transformers?: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      control?: any;
    }
  ) {
    if (options.transformers !== undefined) {
      throw new Error(
        'RemoteGraph.streamEvents({ version: "v3" }) does not support `transformers`.'
      );
    }
    if (options.control !== undefined) {
      throw new Error(
        'RemoteGraph.streamEvents({ version: "v3" }) does not support `control`.'
      );
    }
    if (
      options.interruptBefore !== undefined ||
      this.interruptBefore !== undefined
    ) {
      throw new Error(
        'RemoteGraph.streamEvents({ version: "v3" }) does not support `interruptBefore`.'
      );
    }
    if (
      options.interruptAfter !== undefined ||
      this.interruptAfter !== undefined
    ) {
      throw new Error(
        'RemoteGraph.streamEvents({ version: "v3" }) does not support `interruptAfter`.'
      );
    }
  }

  protected async _streamEventsV3(
    input: PregelInputType,
    options: Partial<PregelOptions<Nn, Cc, ContextType>> & {
      version: "v3";
      encoding?: "text/event-stream";
    }
  ): Promise<
    RemoteGraphRunStream<PregelOutputType> | IterableReadableStream<Uint8Array>
  > {
    this._rejectV3Unsupported(options);

    const abortController = new AbortController();
    const mergedConfig = mergeConfigs(this.config, options);
    const sanitizedConfig = this._sanitizeConfig(mergedConfig);
    const configurable = { ...sanitizedConfig.configurable };
    const threadId = configurable.thread_id;
    delete configurable.thread_id;

    const runConfig = {
      ...sanitizedConfig,
      configurable,
    };

    const thread =
      typeof threadId === "string"
        ? this.client.threads.stream(threadId, { assistantId: this.graphId })
        : this.client.threads.stream({ assistantId: this.graphId });

    let serializedInput;
    if (isCommand(input)) {
      serializedInput = input.toJSON() as Record<string, unknown>;
    } else {
      serializedInput = _serializeInputs(input);
    }

    const run = await thread.run.start({
      input: serializedInput,
      config: runConfig,
    });

    const graphRun = new RemoteGraphRunStream<PregelOutputType>({
      client: this.client,
      thread,
      runId: run.run_id,
      abortController,
    });

    if (mergedConfig.signal != null) {
      if (mergedConfig.signal.aborted) {
        graphRun.abort(mergedConfig.signal.reason);
      } else {
        mergedConfig.signal.addEventListener(
          "abort",
          () => graphRun.abort(mergedConfig.signal?.reason),
          { once: true }
        );
      }
    }

    if (options.encoding === "text/event-stream") {
      const encodingAbortController = new AbortController();
      encodingAbortController.signal.addEventListener(
        "abort",
        () => graphRun.abort(encodingAbortController.signal.reason),
        { once: true }
      );
      return new IterableReadableStreamWithAbortSignal(
        protocolEventsToEventStream(graphRun),
        encodingAbortController
      );
    }

    return graphRun;
  }

  override async *_streamIterator(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ContextType>>
  ): AsyncGenerator<PregelOutputType> {
    const mergedConfig = mergeConfigs(
      this.config,
      options
    ) as LangGraphRunnableConfig;
    const {
      threadId,
      context,
      config: sanitizedConfig,
    } = this.#prepareRunRequest(mergedConfig);

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

    const streamPayload = {
      command,
      input: serializedInput,
      config: sanitizedConfig,
      context,
      streamMode: extendedStreamModes,
      interruptBefore: interruptBefore as string[],
      interruptAfter: interruptAfter as string[],
      streamSubgraphs,
      ifNotExists: "create" as const,
      signal: mergedConfig.signal,
      streamResumable: this.streamResumable,
    };

    const runStream =
      threadId != null
        ? this.client.runs.stream(threadId, this.graphId, streamPayload)
        : this.client.runs.stream(null, this.graphId, streamPayload);

    for await (const chunk of runStream) {
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
      yield this._createStateSnapshot(state, mergedConfig);
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
        name:
          typeof node.data === "string" ? node.data : (node.data?.name ?? ""),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (node.data as any) ?? {},
        metadata:
          typeof node.data !== "string" ? (node.data?.metadata ?? {}) : {},
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
    return this._createStateSnapshot(state, mergedConfig);
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
