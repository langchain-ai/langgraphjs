import { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  mergeConfigs,
  patchConfig,
  Runnable,
  RunnableConfig,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import {
  Graph,
  type Node as RunnableGraphNode,
} from "@langchain/core/runnables/graph";
import { validate as isUuid } from "uuid";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RunnableCallableArgs extends Partial<any> {
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => any;
  tags?: string[];
  trace?: boolean;
  recurse?: boolean;
}

export class RunnableCallable<I = unknown, O = unknown> extends Runnable<I, O> {
  lc_namespace: string[] = ["langgraph"];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  func: (...args: any[]) => any;

  tags?: string[];

  config?: RunnableConfig;

  trace: boolean = true;

  recurse: boolean = true;

  constructor(fields: RunnableCallableArgs) {
    super();
    this.name = fields.name ?? fields.func.name;
    this.func = fields.func;
    this.config = fields.tags ? { tags: fields.tags } : undefined;
    this.trace = fields.trace ?? this.trace;
    this.recurse = fields.recurse ?? this.recurse;
  }

  protected async _tracedInvoke(
    input: I,
    config?: Partial<RunnableConfig>,
    runManager?: CallbackManagerForChainRun
  ) {
    return new Promise<O>((resolve, reject) => {
      const childConfig = patchConfig(config, {
        callbacks: runManager?.getChild(),
      });
      void AsyncLocalStorageProviderSingleton.getInstance().run(
        childConfig,
        async () => {
          try {
            const output = await this.func(input, childConfig);
            resolve(output);
          } catch (e) {
            reject(e);
          }
        }
      );
    });
  }

  async invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    options?: Partial<RunnableConfig> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let returnValue: any;

    if (this.trace) {
      returnValue = await this._callWithConfig(
        this._tracedInvoke,
        input,
        mergeConfigs(this.config, options)
      );
    } else {
      returnValue = await this.func(input, mergeConfigs(this.config, options));
    }

    if (Runnable.isRunnable(returnValue) && this.recurse) {
      return await returnValue.invoke(input, options);
    }

    return returnValue;
  }
}

export class DrawableGraph extends Graph {
  override extend(graph: Graph, prefix: string = "") {
    const nodeIds = Object.values(graph.nodes).map((node) => node.id);
    if (nodeIds.every(isUuid)) {
      super.extend(graph);
      return [graph.firstNode(), graph.lastNode()];
    }
    const newNodes = Object.entries(graph.nodes).reduce(
      (nodes: Record<string, RunnableGraphNode>, [key, value]) => {
        // eslint-disable-next-line no-param-reassign
        nodes[`${prefix}:${key}`] = {
          id: `${prefix}:${key}`,
          data: value.data,
        };
        return nodes;
      },
      {}
    );
    const newEdges = graph.edges.map((edge) => {
      return {
        source: `${prefix}:${edge.source}`,
        target: `${prefix}:${edge.target}`,
        data: edge.data,
        conditional: edge.conditional,
      };
    });
    this.nodes = { ...this.nodes, ...newNodes };
    this.edges = this.edges.concat(newEdges);
    const first = graph.firstNode();
    const last = graph.lastNode();
    return [
      first ? { id: `${prefix}:${first.id}`, data: first.data } : undefined,
      last ? { id: `${prefix}:${last.id}`, data: last.data } : undefined,
    ];
  }
}
