/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  _coerceToRunnable,
  Runnable,
  RunnableConfig,
  RunnableInterface,
  RunnableIOSchema,
  RunnableLike,
} from "@langchain/core/runnables";
import {
  Node as DrawableGraphNode,
  Graph as DrawableGraph,
} from "@langchain/core/runnables/graph";
import { All, BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { validate as isUuid } from "uuid";
import { PregelNode } from "../pregel/read.js";
import { Channel, Pregel } from "../pregel/index.js";
import type { PregelParams } from "../pregel/types.js";
import { BaseChannel } from "../channels/base.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { ChannelWrite, PASSTHROUGH } from "../pregel/write.js";
import {
  _isSend,
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Send,
  TAG_HIDDEN,
} from "../constants.js";
import { gatherIteratorSync, RunnableCallable } from "../utils.js";
import { InvalidUpdateError, NodeInterrupt } from "../errors.js";
import { StateDefinition, StateType } from "./annotation.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { isPregelLike } from "../pregel/utils/subgraph.js";

/** Special reserved node name denoting the start of a graph. */
export const START = "__start__";
/** Special reserved node name denoting the end of a graph. */
export const END = "__end__";

export interface BranchOptions<
  IO,
  N extends string,
  CallOptions extends LangGraphRunnableConfig = LangGraphRunnableConfig
> {
  source: N;
  path: Branch<IO, N, CallOptions>["condition"];
  pathMap?: Record<string, N | typeof END> | (N | typeof END)[];
}

export class Branch<
  IO,
  N extends string,
  CallOptions extends LangGraphRunnableConfig = LangGraphRunnableConfig
> {
  condition: (
    input: IO,
    config: CallOptions
  ) =>
    | string
    | Send
    | (string | Send)[]
    | Promise<string | Send | (string | Send)[]>;

  ends?: Record<string, N | typeof END>;

  constructor(options: Omit<BranchOptions<IO, N, CallOptions>, "source">) {
    this.condition = options.path;
    this.ends = Array.isArray(options.pathMap)
      ? options.pathMap.reduce((acc, n) => {
          acc[n] = n;
          return acc;
        }, {} as Record<string, N | typeof END>)
      : options.pathMap;
  }

  compile(
    writer: (dests: (string | Send)[]) => Runnable | undefined,
    reader?: (config: CallOptions) => IO
  ) {
    return ChannelWrite.registerWriter(
      new RunnableCallable({
        trace: false,
        func: async (input: IO, config: CallOptions) => {
          try {
            return await this._route(input, config, writer, reader);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (e: any) {
            // Detect & warn if NodeInterrupt is thrown in a conditional edge
            if (e.name === NodeInterrupt.unminifiable_name) {
              console.warn(
                "[WARN]: 'NodeInterrupt' thrown in conditional edge. This is likely a bug in your graph implementation.\n" +
                  "NodeInterrupt should only be thrown inside a node, not in edge conditions."
              );
            }
            throw e;
          }
        },
      })
    );
  }

  async _route(
    input: IO,
    config: CallOptions,
    writer: (dests: (string | Send)[]) => Runnable | undefined,
    reader?: (config: CallOptions) => IO
  ): Promise<Runnable | undefined> {
    let result = await this.condition(reader ? reader(config) : input, config);
    if (!Array.isArray(result)) {
      result = [result];
    }

    let destinations: (string | Send)[];
    if (this.ends) {
      destinations = result.map((r) => (_isSend(r) ? r : this.ends![r]));
    } else {
      destinations = result;
    }
    if (destinations.some((dest) => !dest)) {
      throw new Error("Branch condition returned unknown or null destination");
    }
    if (destinations.filter(_isSend).some((packet) => packet.node === END)) {
      throw new InvalidUpdateError("Cannot send a packet to the END node");
    }
    return writer(destinations);
  }
}

export type NodeSpec<RunInput, RunOutput> = {
  runnable: Runnable<RunInput, RunOutput>;
  metadata?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subgraphs?: Pregel<any, any>[];
};

export type AddNodeOptions = {
  metadata?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subgraphs?: Pregel<any, any>[];
};

export class Graph<
  N extends string = typeof END,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any,
  NodeSpecType extends NodeSpec<RunInput, RunOutput> = NodeSpec<
    RunInput,
    RunOutput
  >,
  C extends StateDefinition = StateDefinition
> {
  nodes: Record<N, NodeSpecType>;

  edges: Set<[N | typeof START, N | typeof END]>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  branches: Record<string, Record<string, Branch<RunInput, N, any>>>;

  entryPoint?: string;

  compiled = false;

  constructor() {
    this.nodes = {} as Record<N, NodeSpecType>;
    this.edges = new Set();
    this.branches = {};
  }

  protected warnIfCompiled(message: string): void {
    if (this.compiled) {
      console.warn(message);
    }
  }

  get allEdges(): Set<[string, string]> {
    return this.edges;
  }

  addNode<K extends string, NodeInput = RunInput>(
    key: K,
    action: RunnableLike<
      NodeInput,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      RunOutput extends object ? RunOutput & Record<string, any> : RunOutput,
      LangGraphRunnableConfig<StateType<C>>
    >,
    options?: AddNodeOptions
  ): Graph<N | K, RunInput, RunOutput> {
    for (const reservedChar of [
      CHECKPOINT_NAMESPACE_SEPARATOR,
      CHECKPOINT_NAMESPACE_END,
    ]) {
      if (key.includes(reservedChar)) {
        throw new Error(
          `"${reservedChar}" is a reserved character and is not allowed in node names.`
        );
      }
    }
    this.warnIfCompiled(
      `Adding a node to a graph that has already been compiled. This will not be reflected in the compiled graph.`
    );

    if (key in this.nodes) {
      throw new Error(`Node \`${key}\` already present.`);
    }
    if (key === END) {
      throw new Error(`Node \`${key}\` is reserved.`);
    }

    const runnable = _coerceToRunnable<RunInput, RunOutput>(
      // Account for arbitrary state due to Send API
      action as RunnableLike<RunInput, RunOutput>
    );

    this.nodes[key as unknown as N] = {
      runnable,
      metadata: options?.metadata,
      subgraphs: isPregelLike(runnable) ? [runnable] : options?.subgraphs,
    } as NodeSpecType;

    return this as Graph<N | K, RunInput, RunOutput, NodeSpecType>;
  }

  addEdge(startKey: N | typeof START, endKey: N | typeof END): this {
    this.warnIfCompiled(
      `Adding an edge to a graph that has already been compiled. This will not be reflected in the compiled graph.`
    );

    if (startKey === END) {
      throw new Error("END cannot be a start node");
    }
    if (endKey === START) {
      throw new Error("START cannot be an end node");
    }
    if (
      Array.from(this.edges).some(([start]) => start === startKey) &&
      !("channels" in this)
    ) {
      throw new Error(
        `Already found path for ${startKey}. For multiple edges, use StateGraph.`
      );
    }

    this.edges.add([startKey, endKey]);

    return this;
  }

  addConditionalEdges(
    source: BranchOptions<RunInput, N, LangGraphRunnableConfig<StateType<C>>>
  ): this;

  addConditionalEdges(
    source: N,
    path: Branch<
      RunInput,
      N,
      LangGraphRunnableConfig<StateType<C>>
    >["condition"],
    pathMap?: BranchOptions<
      RunInput,
      N,
      LangGraphRunnableConfig<StateType<C>>
    >["pathMap"]
  ): this;

  addConditionalEdges(
    source:
      | N
      | BranchOptions<RunInput, N, LangGraphRunnableConfig<StateType<C>>>,
    path?: Branch<
      RunInput,
      N,
      LangGraphRunnableConfig<StateType<C>>
    >["condition"],
    pathMap?: BranchOptions<
      RunInput,
      N,
      LangGraphRunnableConfig<StateType<C>>
    >["pathMap"]
  ): this {
    const options: BranchOptions<
      RunInput,
      N,
      LangGraphRunnableConfig<StateType<C>>
    > = typeof source === "object" ? source : { source, path: path!, pathMap };
    this.warnIfCompiled(
      "Adding an edge to a graph that has already been compiled. This will not be reflected in the compiled graph."
    );
    // find a name for condition
    const name = options.path.name || "condition";
    // validate condition
    if (this.branches[options.source] && this.branches[options.source][name]) {
      throw new Error(
        `Condition \`${name}\` already present for node \`${source}\``
      );
    }
    // save it
    if (!this.branches[options.source]) {
      this.branches[options.source] = {};
    }
    this.branches[options.source][name] = new Branch(options);
    return this;
  }

  /**
   * @deprecated use `addEdge(START, key)` instead
   */
  setEntryPoint(key: N): this {
    this.warnIfCompiled(
      "Setting the entry point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    return this.addEdge(START, key);
  }

  /**
   * @deprecated use `addEdge(key, END)` instead
   */
  setFinishPoint(key: N): this {
    this.warnIfCompiled(
      "Setting a finish point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    return this.addEdge(key, END);
  }

  compile({
    checkpointer,
    interruptBefore,
    interruptAfter,
  }: {
    checkpointer?: BaseCheckpointSaver | false;
    interruptBefore?: N[] | All;
    interruptAfter?: N[] | All;
  } = {}): CompiledGraph<N> {
    // validate the graph
    this.validate([
      ...(Array.isArray(interruptBefore) ? interruptBefore : []),
      ...(Array.isArray(interruptAfter) ? interruptAfter : []),
    ]);

    // create empty compiled graph
    const compiled = new CompiledGraph({
      builder: this,
      checkpointer,
      interruptAfter,
      interruptBefore,
      autoValidate: false,
      nodes: {} as Record<N | typeof START, PregelNode<RunInput, RunOutput>>,
      channels: {
        [START]: new EphemeralValue(),
        [END]: new EphemeralValue(),
      } as Record<N | typeof START | typeof END | string, BaseChannel>,
      inputChannels: START,
      outputChannels: END,
      streamChannels: [] as N[],
      streamMode: "values",
    });

    // attach nodes, edges and branches
    for (const [key, node] of Object.entries<NodeSpec<RunInput, RunOutput>>(
      this.nodes
    )) {
      compiled.attachNode(key as N, node);
    }
    for (const [start, end] of this.edges) {
      compiled.attachEdge(start, end);
    }
    for (const [start, branches] of Object.entries(this.branches)) {
      for (const [name, branch] of Object.entries(branches)) {
        compiled.attachBranch(start as N, name, branch);
      }
    }

    return compiled.validate();
  }

  validate(interrupt?: string[]): void {
    // assemble sources
    const allSources = new Set([...this.allEdges].map(([src, _]) => src));
    for (const [start] of Object.entries(this.branches)) {
      allSources.add(start);
    }
    for (const source of allSources) {
      if (source !== START && !(source in this.nodes)) {
        throw new Error(`Found edge starting at unknown node \`${source}\``);
      }
    }

    // assemble targets
    const allTargets = new Set([...this.allEdges].map(([_, target]) => target));
    for (const [start, branches] of Object.entries(this.branches)) {
      for (const branch of Object.values(branches)) {
        if (branch.ends) {
          for (const end of Object.values(branch.ends)) {
            allTargets.add(end);
          }
        } else {
          allTargets.add(END);
          for (const node of Object.keys(this.nodes)) {
            if (node !== start) {
              allTargets.add(node);
            }
          }
        }
      }
    }
    // validate targets
    for (const node of Object.keys(this.nodes)) {
      if (!allTargets.has(node)) {
        throw new Error(`Node \`${node}\` is not reachable`);
      }
    }
    for (const target of allTargets) {
      if (target !== END && !(target in this.nodes)) {
        throw new Error(`Found edge ending at unknown node \`${target}\``);
      }
    }

    // validate interrupts
    if (interrupt) {
      for (const node of interrupt) {
        if (!(node in this.nodes)) {
          throw new Error(`Interrupt node \`${node}\` is not present`);
        }
      }
    }

    this.compiled = true;
  }
}

export class CompiledGraph<
  N extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableFieldType extends Record<string, any> = Record<string, any>
> extends Pregel<
  Record<N | typeof START, PregelNode<RunInput, RunOutput>>,
  Record<N | typeof START | typeof END | string, BaseChannel>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableFieldType & Record<string, any>
> {
  declare NodeType: N;

  declare RunInput: RunInput;

  declare RunOutput: RunOutput;

  builder: Graph<N, RunInput, RunOutput>;

  constructor({
    builder,
    ...rest
  }: { builder: Graph<N, RunInput, RunOutput> } & PregelParams<
    Record<N | typeof START, PregelNode<RunInput, RunOutput>>,
    Record<N | typeof START | typeof END | string, BaseChannel>
  >) {
    super(rest);
    this.builder = builder;
  }

  attachNode(key: N, node: NodeSpec<RunInput, RunOutput>): void {
    this.channels[key] = new EphemeralValue();
    this.nodes[key] = new PregelNode({
      channels: [],
      triggers: [],
      metadata: node.metadata,
      subgraphs: node.subgraphs,
    })
      .pipe(node.runnable)
      .pipe(
        new ChannelWrite([{ channel: key, value: PASSTHROUGH }], [TAG_HIDDEN])
      );
    (this.streamChannels as N[]).push(key);
  }

  attachEdge(start: N | typeof START, end: N | typeof END): void {
    if (end === END) {
      if (start === START) {
        throw new Error("Cannot have an edge from START to END");
      }
      this.nodes[start].writers.push(
        new ChannelWrite([{ channel: END, value: PASSTHROUGH }], [TAG_HIDDEN])
      );
    } else {
      this.nodes[end].triggers.push(start);
      (this.nodes[end].channels as string[]).push(start);
    }
  }

  attachBranch(
    start: N | typeof START,
    name: string,
    branch: Branch<RunInput, N>
  ) {
    // add hidden start node
    if (start === START && this.nodes[START]) {
      this.nodes[START] = Channel.subscribeTo(START, { tags: [TAG_HIDDEN] });
    }

    // attach branch writer
    this.nodes[start].pipe(
      branch.compile((dests) => {
        const writes = dests.map((dest) => {
          if (_isSend(dest)) {
            return dest;
          }
          return {
            channel: dest === END ? END : `branch:${start}:${name}:${dest}`,
            value: PASSTHROUGH,
          };
        });
        return new ChannelWrite(writes, [TAG_HIDDEN]);
      })
    );

    // attach branch readers
    const ends = branch.ends
      ? Object.values(branch.ends)
      : (Object.keys(this.nodes) as N[]);
    for (const end of ends) {
      if (end !== END) {
        const channelName = `branch:${start}:${name}:${end}`;
        (this.channels as Record<string, BaseChannel>)[channelName] =
          new EphemeralValue();
        this.nodes[end].triggers.push(channelName);
        (this.nodes[end].channels as string[]).push(channelName);
      }
    }
  }

  /**
   * Returns a drawable representation of the computation graph.
   */
  override getGraph(
    config?: RunnableConfig & { xray?: boolean | number }
  ): DrawableGraph {
    const xray = config?.xray;
    const graph = new DrawableGraph();
    const startNodes: Record<string, DrawableGraphNode> = {
      [START]: graph.addNode(
        {
          schema: z.any(),
        },
        START
      ),
    };
    const endNodes: Record<string, DrawableGraphNode> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let subgraphs: Record<string, CompiledGraph<any>> = {};
    if (xray) {
      subgraphs = Object.fromEntries(
        gatherIteratorSync(this.getSubgraphs()).filter(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (x): x is [string, CompiledGraph<any>] => isCompiledGraph(x[1])
        )
      );
    }

    function addEdge(
      start: string,
      end: string,
      label?: string,
      conditional = false
    ) {
      if (end === END && endNodes[END] === undefined) {
        endNodes[END] = graph.addNode({ schema: z.any() }, END);
      }
      return graph.addEdge(
        startNodes[start],
        endNodes[end],
        label !== end ? label : undefined,
        conditional
      );
    }

    for (const [key, nodeSpec] of Object.entries(this.builder.nodes) as [
      N,
      NodeSpec<RunInput, RunOutput>
    ][]) {
      const displayKey = _escapeMermaidKeywords(key);
      const node = nodeSpec.runnable;
      const metadata = nodeSpec.metadata ?? {};
      if (
        this.interruptBefore?.includes(key) &&
        this.interruptAfter?.includes(key)
      ) {
        metadata.__interrupt = "before,after";
      } else if (this.interruptBefore?.includes(key)) {
        metadata.__interrupt = "before";
      } else if (this.interruptAfter?.includes(key)) {
        metadata.__interrupt = "after";
      }
      if (xray) {
        const newXrayValue = typeof xray === "number" ? xray - 1 : xray;
        const drawableSubgraph =
          subgraphs[key] !== undefined
            ? subgraphs[key].getGraph({
                ...config,
                xray: newXrayValue,
              })
            : node.getGraph(config);
        drawableSubgraph.trimFirstNode();
        drawableSubgraph.trimLastNode();
        if (Object.keys(drawableSubgraph.nodes).length > 1) {
          const [e, s] = graph.extend(drawableSubgraph, displayKey);
          if (e === undefined) {
            throw new Error(
              `Could not extend subgraph "${key}" due to missing entrypoint.`
            );
          }

          // TODO: Remove default name once we stop supporting core 0.2.0
          // eslint-disable-next-line no-inner-declarations
          function _isRunnableInterface(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            thing: any
          ): thing is RunnableInterface {
            return thing ? thing.lc_runnable : false;
          }
          // eslint-disable-next-line no-inner-declarations
          function _nodeDataStr(
            id: string | undefined,
            data: RunnableInterface | RunnableIOSchema
          ): string {
            if (id !== undefined && !isUuid(id)) {
              return id;
            } else if (_isRunnableInterface(data)) {
              try {
                let dataStr = data.getName();
                dataStr = dataStr.startsWith("Runnable")
                  ? dataStr.slice("Runnable".length)
                  : dataStr;
                return dataStr;
              } catch (error) {
                return data.getName();
              }
            } else {
              return data.name ?? "UnknownSchema";
            }
          }
          // TODO: Remove casts when we stop supporting core 0.2.0
          if (s !== undefined) {
            startNodes[displayKey] = {
              name: _nodeDataStr(s.id, s.data),
              ...s,
            } as DrawableGraphNode;
          }
          endNodes[displayKey] = {
            name: _nodeDataStr(e.id, e.data),
            ...e,
          } as DrawableGraphNode;
        } else {
          // TODO: Remove when we stop supporting core 0.2.0
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          const newNode = graph.addNode(node, displayKey, metadata);
          startNodes[displayKey] = newNode;
          endNodes[displayKey] = newNode;
        }
      } else {
        // TODO: Remove when we stop supporting core 0.2.0
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        const newNode = graph.addNode(node, displayKey, metadata);
        startNodes[displayKey] = newNode;
        endNodes[displayKey] = newNode;
      }
    }
    const sortedEdges = [...this.builder.allEdges].sort(([a], [b]) => {
      if (a < b) {
        return -1;
      } else if (b > a) {
        return 1;
      } else {
        return 0;
      }
    });
    for (const [start, end] of sortedEdges) {
      addEdge(_escapeMermaidKeywords(start), _escapeMermaidKeywords(end));
    }
    for (const [start, branches] of Object.entries(this.builder.branches)) {
      const defaultEnds: Record<string, string> = {
        ...Object.fromEntries(
          Object.keys(this.builder.nodes)
            .filter((k) => k !== start)
            .map((k) => [_escapeMermaidKeywords(k), _escapeMermaidKeywords(k)])
        ),
        [END]: END,
      };
      for (const branch of Object.values(branches)) {
        let ends;
        if (branch.ends !== undefined) {
          ends = branch.ends;
        } else {
          ends = defaultEnds;
        }
        for (const [label, end] of Object.entries(ends)) {
          addEdge(
            _escapeMermaidKeywords(start),
            _escapeMermaidKeywords(end),
            label,
            true
          );
        }
      }
    }
    return graph;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isCompiledGraph(x: unknown): x is CompiledGraph<any> {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (x as CompiledGraph<any>).attachNode === "function" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (x as CompiledGraph<any>).attachEdge === "function"
  );
}

function _escapeMermaidKeywords(key: string) {
  if (key === "subgraph") {
    return `"${key}"`;
  }
  return key;
}
