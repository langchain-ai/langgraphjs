import {
  Runnable,
  RunnableConfig,
  RunnableLambda,
  RunnableLike,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { PregelNode } from "../pregel/read.js";
import { Channel, Pregel } from "../pregel/index.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { BaseChannel } from "../channels/base.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";

export const END = "__end__";

type EndsMap = { [result: string]: string };

class Branch {
  condition: CallableFunction;

  ends?: EndsMap;

  constructor(condition: CallableFunction, ends?: EndsMap) {
    this.condition = condition;
    this.ends = ends;
  }

  public async runnable(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    options?: { config?: RunnableConfig }
  ): Promise<Runnable> {
    const result = await this.condition(input, options?.config);
    let destination;
    if (this.ends) {
      destination = this.ends[result];
    } else {
      destination = result;
    }
    return Channel.writeTo(
      destination !== END ? [`${destination}:inbox`] : [END]
    );
  }
}

export class Graph<
  const N extends string = typeof END,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> {
  nodes: Record<N, Runnable<RunInput, RunOutput>>;

  edges: Set<[string, string]>;

  branches: Record<string, Branch[]>;

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

  addNode<K extends string>(key: K, action: RunnableLike<RunInput, RunOutput>) {
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
      action
    );

    return this as Graph<N | K, RunInput, RunOutput>;
  }

  addEdge(startKey: N, endKey: N | typeof END): this {
    this.warnIfCompiled(
      `Adding an edge to a graph that has already been compiled. This will not be reflected in the compiled graph.`
    );

    if (startKey === END) {
      throw new Error("END cannot be a start node");
    }
    if (!(startKey in this.nodes)) {
      throw new Error(`Need to addNode \`${startKey}\` first`);
    }
    if (!(endKey in this.nodes) && endKey !== END) {
      throw new Error(`Need to addNode \`${endKey}\` first`);
    }

    if (
      !this.supportMultipleEdges &&
      Array.from(this.edges).some(([start]) => start === startKey)
    ) {
      throw new Error(`Already found path for ${startKey}`);
    }

    this.edges.add([startKey, endKey]);

    return this;
  }

  addConditionalEdges(
    startKey: N,
    condition: CallableFunction,
    conditionalEdgeMapping?: Record<string, N | typeof END>
  ): this {
    this.warnIfCompiled(
      "Adding an edge to a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    if (!(startKey in this.nodes)) {
      throw new Error(`Need to addNode \`${startKey}\` first`);
    }
    if (conditionalEdgeMapping) {
      const mappingValues = Array.from(Object.values(conditionalEdgeMapping));
      const nodesValues = Object.keys(this.nodes);
      const endExcluded = mappingValues.filter((value) => value !== END);
      const difference = endExcluded.filter(
        (value) => !nodesValues.some((nv) => nv === value)
      );

      if (difference.length > 0) {
        throw new Error(
          `Missing nodes which are in conditional edge mapping.\nMapping contains possible destinations: ${mappingValues.join(
            ", "
          )}.\nPossible nodes are ${nodesValues.join(", ")}.`
        );
      }
    }

    if (!this.branches[startKey]) {
      this.branches[startKey] = [];
    }
    this.branches[startKey].push(new Branch(condition, conditionalEdgeMapping));

    return this;
  }

  setEntryPoint(key: N): this {
    this.warnIfCompiled(
      "Setting the entry point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    if (!(key in this.nodes)) {
      throw new Error(`Need to addNode \`${key}\` first`);
    }
    this.entryPoint = key;

    return this;
  }

  setFinishPoint(key: N): this {
    this.warnIfCompiled(
      "Setting a finish point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    return this.addEdge(key, END);
  }

  compile(
    checkpointer?: BaseCheckpointSaver
  ): Pregel<
    Record<N, PregelNode<RunInput, RunOutput>>,
    Record<N, BaseChannel>
  > {
    this.validate();

    const outgoingEdges: Record<string, string[]> = {};
    this.edges.forEach(([start, end]) => {
      if (!outgoingEdges[start]) {
        outgoingEdges[start] = [];
      }
      outgoingEdges[start].push(end !== END ? `${end}:inbox` : END);
    });

    const nodes = {} as Record<string, PregelNode<RunInput, RunOutput>>;
    const channels = {
      [END]: new EphemeralValue(),
    } as Record<string, BaseChannel>;
    for (const [key, node] of Object.entries<Runnable<RunInput, RunOutput>>(
      this.nodes
    )) {
      const inboxKey = `${key}:inbox`;
      channels[key] = new EphemeralValue();
      channels[inboxKey] = new EphemeralValue();
      nodes[key as N] = Channel.subscribeTo(inboxKey)
        .pipe(node)
        .pipe(Channel.writeTo([key]));
    }

    for (const key of Object.keys(this.nodes)) {
      const outgoing = outgoingEdges[key];
      const edgesKey = `${key}:edges`;
      if (outgoing || this.branches[key]) {
        nodes[edgesKey] = Channel.subscribeTo(key, {
          tags: ["langsmith:hidden"],
        });
      }
      if (outgoing) {
        nodes[edgesKey] = nodes[edgesKey].pipe(Channel.writeTo(outgoing));
      }
      if (this.branches[key]) {
        this.branches[key].forEach((branch) => {
          const runnableLambda = new RunnableLambda<RunInput, RunOutput>({
            func: (input: RunInput) => branch.runnable(input),
          });

          nodes[edgesKey] = nodes[edgesKey].pipe(runnableLambda);
        });
      }
    }

    if (!this.entryPoint) {
      throw new Error("Entry point not set");
    }
    return new Pregel({
      nodes,
      channels,
      inputs: `${this.entryPoint}:inbox`,
      outputs: END,
      checkpointer,
    });
  }

  validate(): void {
    const allStarts = new Set(
      [...this.allEdges]
        .map(([src, _]) => src)
        .concat(Object.keys(this.branches))
    );

    for (const node of Object.keys(this.nodes)) {
      if (!allStarts.has(node)) {
        throw new Error(`Node \`${node}\` is a dead-end`);
      }
    }

    const allEndsAreDefined = Object.values(this.branches).every((branchList) =>
      branchList.every((branch) => branch.ends)
    );

    if (allEndsAreDefined) {
      const allEnds = new Set(
        [...this.allEdges]
          .map(([_, end]) => end)
          .concat(
            ...Object.values(this.branches).flatMap((branchList) =>
              branchList.flatMap((branch) => Object.values(branch.ends ?? {}))
            )
          )
          .concat(this.entryPoint ? [this.entryPoint] : [])
      );

      for (const node of Object.keys(this.nodes)) {
        if (!allEnds.has(node)) {
          throw new Error(`Node \`${node}\` is not reachable`);
        }
      }
    }
    this.compiled = true;
  }
}
