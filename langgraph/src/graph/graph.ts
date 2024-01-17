import {
  Runnable,
  RunnableLambda,
  RunnableLike,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { ChannelBatch, ChannelInvoke } from "../pregel/read.js";
import { Channel, Pregel } from "../pregel/index.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";

export const END = "__end__";

type EndsMap = { [result: string]: string };

class Branch {
  condition: CallableFunction;

  ends: EndsMap;

  constructor(condition: CallableFunction, ends: EndsMap) {
    this.condition = condition;
    this.ends = ends;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public runnable(input: any): Runnable {
    const result = this.condition(input);
    const destination = this.ends[result];
    return Channel.writeTo(destination !== END ? `${destination}:inbox` : END);
  }
}

export class Graph<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
> {
  nodes: Record<string, Runnable<RunInput, RunOutput>>;

  edges: Set<[string, string]>;

  branches: Record<string, Branch[]>;

  entryPoint?: string;

  constructor() {
    this.nodes = {};
    this.edges = new Set();
    this.branches = {};
  }

  addNode(key: string, action: RunnableLike<RunInput, RunOutput>): void {
    if (this.nodes[key]) {
      throw new Error(`Node \`${key}\` already present.`);
    }
    if (key === END) {
      throw new Error(`Node \`${key}\` is reserved.`);
    }

    this.nodes[key] = _coerceToRunnable<RunInput, RunOutput>(action);
  }

  addEdge(startKey: string, endKey: string): void {
    if (startKey === END) {
      throw new Error("END cannot be a start node");
    }
    if (!this.nodes[startKey]) {
      throw new Error(`Need to addNode \`${startKey}\` first`);
    }
    if (!this.nodes[endKey] && endKey !== END) {
      throw new Error(`Need to addNode \`${endKey}\` first`);
    }

    // TODO: support multiple message passing
    if (Array.from(this.edges).some(([start]) => start === startKey)) {
      throw new Error(`Already found path for ${startKey}`);
    }

    this.edges.add([startKey, endKey]);
  }

  addConditionalEdges(
    startKey: string,
    condition: CallableFunction,
    conditionalEdgeMapping: Record<string, string>
  ): void {
    if (!this.nodes[startKey]) {
      throw new Error(`Need to addNode \`${startKey}\` first`);
    }
    if (condition.constructor.name === "AsyncFunction") {
      throw new Error("Condition cannot be an async function");
    }
    for (const destination of Object.values(conditionalEdgeMapping)) {
      if (!this.nodes[destination] && destination !== END) {
        throw new Error(`Need to addNode \`${destination}\` first`);
      }
    }

    if (!this.branches[startKey]) {
      this.branches[startKey] = [];
    }
    this.branches[startKey].push(new Branch(condition, conditionalEdgeMapping));
  }

  setEntryPoint(key: string): void {
    if (!this.nodes[key]) {
      throw new Error(`Need to addNode \`${key}\` first`);
    }
    this.entryPoint = key;
  }

  setFinishPoint(key: string): void {
    this.addEdge(key, END);
  }

  compile(checkpointer?: BaseCheckpointSaver): Pregel {
    this.validate();

    const outgoingEdges: Record<string, string[]> = {};
    this.edges.forEach(([start, end]) => {
      if (!outgoingEdges[start]) {
        outgoingEdges[start] = [];
      }
      outgoingEdges[start].push(end !== END ? `${end}:inbox` : END);
    });

    const nodes: Record<
      string,
      ChannelInvoke<RunInput, RunOutput> | ChannelBatch
    > = {};
    for (const [key, node] of Object.entries(this.nodes)) {
      nodes[key] = Channel.subscribeTo(`${key}:inbox`)
        .pipe(node)
        .pipe(Channel.writeTo(key));
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
        nodes[edgesKey] = nodes[edgesKey].pipe(Channel.writeTo(...outgoing));
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

    const hidden = Object.keys(this.nodes).map((node) => `${node}:inbox`);

    if (!this.entryPoint) {
      throw new Error("Entry point not set");
    }
    return new Pregel({
      nodes,
      input: `${this.entryPoint}:inbox`,
      output: END,
      hidden,
      checkpointer,
    });
  }

  validate(): void {
    const allStarts = new Set(
      [...this.edges].map(([src, _]) => src).concat(Object.keys(this.branches))
    );
    const allEnds = new Set(
      [...this.edges]
        .map(([_, end]) => end)
        .concat(
          ...Object.values(this.branches).flatMap((branchList) =>
            branchList.flatMap((branch) => Object.values(branch.ends))
          )
        )
        .concat(this.entryPoint ? [this.entryPoint] : [])
    );

    for (const node of Object.keys(this.nodes)) {
      if (!allEnds.has(node)) {
        throw new Error(`Node \`${node}\` is not reachable`);
      }
      if (!allStarts.has(node)) {
        throw new Error(`Node \`${node}\` is a dead-end`);
      }
    }
  }
}
