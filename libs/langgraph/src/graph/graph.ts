/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  Runnable,
  RunnableConfig,
  RunnableLike,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import {
  Node as RunnableGraphNode,
  Graph as RunnableGraph,
} from "@langchain/core/runnables/graph";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { z } from "zod";
import { PregelNode } from "../pregel/read.js";
import { Channel, Pregel } from "../pregel/index.js";
import type { PregelParams } from "../pregel/types.js";
import { BaseChannel } from "../channels/base.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { All } from "../pregel/types.js";
import { ChannelWrite, PASSTHROUGH } from "../pregel/write.js";
import {
  _isSend,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Send,
  TAG_HIDDEN,
} from "../constants.js";
import { RunnableCallable } from "../utils.js";
import { InvalidUpdateError } from "../errors.js";

export const START = "__start__";
export const END = "__end__";

export interface BranchOptions<IO, N extends string> {
  source: N;
  path: Branch<IO, N>["condition"];
  pathMap?: Record<string, N | typeof END> | N[];
}

export class Branch<IO, N extends string> {
  condition: (
    input: IO,
    config?: RunnableConfig
  ) =>
    | string
    | Send
    | (string | Send)[]
    | Promise<string | Send | (string | Send)[]>;

  ends?: Record<string, N | typeof END>;

  constructor(options: Omit<BranchOptions<IO, N>, "source">) {
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
    reader?: (config: RunnableConfig) => IO
  ) {
    return ChannelWrite.registerWriter(
      new RunnableCallable({
        func: (input: IO, config: RunnableConfig) =>
          this._route(input, config, writer, reader),
      })
    );
  }

  async _route(
    input: IO,
    config: RunnableConfig,
    writer: (dests: (string | Send)[]) => Runnable | undefined,
    reader?: (config: RunnableConfig) => IO
  ): Promise<Runnable | undefined> {
    let result = await this.condition(reader ? reader(config) : input, config);
    if (!Array.isArray(result)) {
      result = [result];
    }

    let destinations: (string | Send)[];
    if (this.ends) {
      // destinations = [r if isinstance(r, Send) else self.ends[r] for r in result]
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

export class Graph<
  N extends string = typeof END,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> {
  nodes: Record<N, Runnable<RunInput, RunOutput>>;

  edges: Set<[N | typeof START, N | typeof END]>;

  branches: Record<string, Record<string, Branch<RunInput, N>>>;

  entryPoint?: string;

  compiled = false;

  supportMultipleEdges = false;

  constructor() {
    this.nodes = {} as Record<N, Runnable<RunInput, RunOutput>>;
    this.edges = new Set();
    this.branches = {};
  }

  private warnIfCompiled(message: string): void {
    if (this.compiled) {
      console.warn(message);
    }
  }

  get allEdges(): Set<[string, string]> {
    return this.edges;
  }

  addNode<K extends string, NodeInput = RunInput>(
    key: K,
    action: RunnableLike<NodeInput, RunOutput>
  ): Graph<N | K, RunInput, RunOutput> {
    if (key.includes(CHECKPOINT_NAMESPACE_SEPARATOR)) {
      throw new Error(
        `"${CHECKPOINT_NAMESPACE_SEPARATOR}" is a reserved character and is not allowed in node names.`
      );
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

    this.nodes[key as unknown as N] = _coerceToRunnable<RunInput, RunOutput>(
      // Account for arbitrary state due to Send API
      action as RunnableLike<RunInput, RunOutput>
    );

    return this as Graph<N | K, RunInput, RunOutput>;
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
      !this.supportMultipleEdges &&
      Array.from(this.edges).some(([start]) => start === startKey)
    ) {
      throw new Error(
        `Already found path for ${startKey}. For multiple edges, use StateGraph with an annotated state key.`
      );
    }

    this.edges.add([startKey, endKey]);

    return this;
  }

  addConditionalEdges(source: BranchOptions<RunInput, N>): this;

  addConditionalEdges(
    source: N,
    path: Branch<RunInput, N>["condition"],
    pathMap?: BranchOptions<RunInput, N>["pathMap"]
  ): this;

  addConditionalEdges(
    source: N | BranchOptions<RunInput, N>,
    path?: Branch<RunInput, N>["condition"],
    pathMap?: BranchOptions<RunInput, N>["pathMap"]
  ): this {
    const options: BranchOptions<RunInput, N> =
      typeof source === "object" ? source : { source, path: path!, pathMap };
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
    checkpointer?: BaseCheckpointSaver;
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
    for (const [key, node] of Object.entries<Runnable<RunInput, RunOutput>>(
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
    // validate sources
    for (const node of Object.keys(this.nodes)) {
      if (!allSources.has(node)) {
        throw new Error(`Node \`${node}\` is a dead-end`);
      }
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
  RunOutput = any
> extends Pregel<
  Record<N | typeof START, PregelNode<RunInput, RunOutput>>,
  Record<N | typeof START | typeof END | string, BaseChannel>
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

  attachNode(key: N, node: Runnable<RunInput, RunOutput>): void {
    this.channels[key] = new EphemeralValue();
    this.nodes[key] = new PregelNode({
      channels: [],
      triggers: [],
    })
      .pipe(node)
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
  ): RunnableGraph {
    const xray = config?.xray;
    const graph = new RunnableGraph();
    const startNodes: Record<string, RunnableGraphNode> = {
      [START]: graph.addNode(
        {
          schema: z.any(),
        },
        START
      ),
    };
    const endNodes: Record<string, RunnableGraphNode> = {
      [END]: graph.addNode(
        {
          schema: z.any(),
        },
        END
      ),
    };
    for (const [key, node] of Object.entries<Runnable>(this.builder.nodes)) {
      if (config?.xray) {
        const subgraph = isCompiledGraph(node)
          ? node.getGraph({
              ...config,
              xray: typeof xray === "number" && xray > 0 ? xray - 1 : xray,
            })
          : node.getGraph(config);
        subgraph.trimFirstNode();
        subgraph.trimLastNode();
        if (Object.keys(subgraph.nodes).length > 1) {
          const [newEndNode, newStartNode] = graph.extend(subgraph, key);
          if (newEndNode !== undefined) {
            endNodes[key] = newEndNode;
          }
          if (newStartNode !== undefined) {
            startNodes[key] = newStartNode;
          }
        } else {
          const newNode = graph.addNode(node, key);
          startNodes[key] = newNode;
          endNodes[key] = newNode;
        }
      } else {
        const newNode = graph.addNode(node, key);
        startNodes[key] = newNode;
        endNodes[key] = newNode;
      }
    }
    for (const [start, end] of this.builder.allEdges) {
      graph.addEdge(startNodes[start], endNodes[end]);
    }
    for (const [start, branches] of Object.entries(this.builder.branches)) {
      const defaultEnds: Record<string, string> = {
        ...Object.fromEntries(
          Object.keys(this.builder.nodes)
            .filter((k) => k !== start)
            .map((k) => [k, k])
        ),
        [END]: END,
      };
      for (const branch of Object.values(branches)) {
        let ends: Record<string, string>;
        if (branch.ends !== undefined) {
          ends = branch.ends;
        } else {
          ends = defaultEnds;
        }
        for (const [label, end] of Object.entries(ends)) {
          graph.addEdge(
            startNodes[start],
            endNodes[end],
            label !== end ? label : undefined,
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
