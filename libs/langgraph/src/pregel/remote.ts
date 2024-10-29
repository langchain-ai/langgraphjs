import type { Client, Checkpoint, ThreadState } from "@langchain/langgraph-sdk";
import {
  Graph as DrawableGraph,
  Node as DrawableNode,
  Edge as DrawableEdge,
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

import {
  BaseChannel,
  LangGraphRunnableConfig,
  ManagedValueSpec,
} from "../web.js";
import { StrRecord } from "./algo.js";
import { PregelInputType, PregelOptions, PregelOutputType } from "./index.js";
import { PregelNode } from "./read.js";
import {
  PregelParams,
  PregelInterface,
  PregelTaskDescription,
  StateSnapshot,
} from "./types.js";
import { Interrupt } from "../constants.js";

export type RemoteGraphParams = Omit<
  PregelParams<
    StrRecord<string, PregelNode>,
    StrRecord<string, BaseChannel | ManagedValueSpec>
  >,
  "channels" | "nodes" | "inputChannels" | "outputChannels"
> & {
  graphId: string;
  client: Client;
};

export class RemoteGraph<
    Nn extends StrRecord<string, PregelNode> = StrRecord<string, PregelNode>,
    Cc extends StrRecord<string, BaseChannel | ManagedValueSpec> = StrRecord<
      string,
      BaseChannel | ManagedValueSpec
    >,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConfigurableFieldType extends Record<string, any> = StrRecord<string, any>
  >
  extends Runnable<
    PregelInputType,
    PregelOutputType,
    PregelOptions<Nn, Cc, ConfigurableFieldType>
  >
  implements PregelInterface<Nn, Cc, ConfigurableFieldType>
{
  static lc_name() {
    return "RemoteGraph";
  }

  lc_namespace = ["langgraph", "pregel"];

  lg_is_pregel = true;

  config?: RunnableConfig;

  protected graphId: string;

  protected client: Client;

  protected interruptBefore?: Array<keyof Nn> | All;

  protected interruptAfter?: Array<keyof Nn> | All;

  constructor(params: RemoteGraphParams) {
    super(params);

    this.graphId = params.graphId;
    this.client = params.client;
    this.config = params.config;
    this.interruptBefore = params.interruptBefore;
    this.interruptAfter = params.interruptAfter;
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

    const sanitizeObj = (obj: any): any => {
      // Remove non-JSON serializable fields from the given object
      if (obj && typeof obj === "object") {
        if (Array.isArray(obj)) {
          return obj.map((v) => sanitizeObj(v));
        } else {
          return Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, sanitizeObj(v)])
          );
        }
      }

      try {
        JSON.stringify(obj);
        return obj;
      } catch {
        return null;
      }
    };

    // Remove non-JSON serializable fields from the config
    config = sanitizeObj(config);

    // Only include configurable keys that are not reserved and
    // not starting with "__pregel_" prefix
    const newConfigurable = Object.fromEntries(
      Object.entries(config.configurable ?? {}).filter(
        ([k]) => !reservedConfigurableKeys.has(k) && !k.startsWith("__pregel_")
      )
    );

    return { configurable: newConfigurable };
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
        interrupts: task.interrupts as Interrupt[],
        state: task.state
          ? this._createStateSnapshot(task.state)
          : task.checkpoint
          ? { configurable: task.checkpoint }
          : undefined,
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
        ? (state.metadata as unknown as CheckpointMetadata)
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
    options?: Partial<PregelOptions<Nn, Cc, ConfigurableFieldType>>
  ): Promise<PregelOutputType> {
    const mergedConfig = mergeConfigs(this.config, options);
    const sanitizedConfig = this._sanitizeConfig(mergedConfig);

    const interruptBefore = this.interruptBefore ?? options?.interruptBefore;
    const interruptAfter = this.interruptAfter ?? options?.interruptAfter;

    return this.client.runs.wait(
      sanitizedConfig.configurable?.thread_id,
      this.graphId,
      {
        input,
        config: sanitizedConfig,
        interruptBefore: interruptBefore as string[],
        interruptAfter: interruptAfter as string[],
      }
    );
  }

  override async *_streamIterator(
    input: PregelInputType,
    options?: Partial<PregelOptions<Nn, Cc, ConfigurableFieldType>>
  ): AsyncGenerator<PregelOutputType> {
    const mergedConfig = mergeConfigs(this.config, options);
    const sanitizedConfig = this._sanitizeConfig(mergedConfig);

    const interruptBefore = this.interruptBefore ?? options?.interruptBefore;
    const interruptAfter = this.interruptAfter ?? options?.interruptAfter;

    yield* this.client.runs.stream(
      sanitizedConfig.configurable.thread_id,
      this.graphId,
      {
        input,
        config: sanitizedConfig,
        streamMode:
          options?.streamMode !== undefined ? options.streamMode : "values",
        interruptBefore: interruptBefore as string[],
        interruptAfter: interruptAfter as string[],
        streamSubgraphs: options?.subgraphs,
      }
    );
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
      data?: Record<string, unknown>;
      metadata?: unknown;
    }>
  ): Record<string, DrawableNode> {
    const nodesMap: Record<string, DrawableNode> = {};
    for (const node of nodes) {
      const nodeId = node.id;
      nodesMap[nodeId] = {
        id: nodeId.toString(),
        name: node.name ?? "",
        data: (node.data as any) ?? {},
        metadata: node.metadata as any,
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
      {
        checkpoint: this._getCheckpoint(mergedConfig),
        subgraphs: options?.subgraphs,
      } as any
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
      nodes: this._getDrawableNodes(graph.nodes as any),
      edges: graph.edges as unknown as DrawableEdge[],
    });
  }

  /** @deprecated Use getSubgraphsAsync instead. The async method will become the default in the next minor release. */
  getSubgraphs(): Generator<
    [string, PregelInterface<Nn, Cc, ConfigurableFieldType>]
  > {
    throw new Error(
      `The synchronous "getSubgraphs" method is not supported for this graph. Call "getSubgraphsAsync" instead.`
    );
  }

  async *getSubgraphsAsync(
    namespace?: string,
    recurse = false
  ): AsyncGenerator<[string, PregelInterface<Nn, Cc, ConfigurableFieldType>]> {
    const subgraphs = await this.client.assistants.getSubgraphs(this.graphId, {
      namespace,
      recurse,
    });

    for (const [ns, graphSchema] of Object.entries(subgraphs)) {
      const remoteSubgraph = new (this.constructor as any)({
        ...this,
        graphId: graphSchema.graph_id,
      });
      yield [ns, remoteSubgraph];
    }
  }
}
