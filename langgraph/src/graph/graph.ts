/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  Runnable,
  RunnableConfig,
  RunnableLike,
  _coerceToRunnable,
} from "@langchain/core/runnables";
import { PregelNode } from "../pregel/read.js";
import { Channel, Pregel, PregelInterface } from "../pregel/index.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { BaseChannel } from "../channels/base.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { All } from "../pregel/types.js";
import { ChannelWrite, PASSTHROUGH } from "../pregel/write.js";
import { TAG_HIDDEN } from "../constants.js";
import { RunnableCallable } from "../utils.js";

export const START = "__start__";
export const END = "__end__";

export class Branch<IO, N extends string> {
  condition: (
    input: IO,
    config?: RunnableConfig
  ) => string | string[] | Promise<string> | Promise<string[]>;

  ends?: Record<string, N | typeof END>;

  constructor(
    condition: Branch<IO, N>["condition"],
    ends?: Branch<IO, N>["ends"]
  ) {
    this.condition = condition;
    this.ends = ends;
  }

  compile(
    writer: (dests: string[]) => Runnable | undefined,
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
    writer: (dests: string[]) => Runnable | undefined,
    reader?: (config: RunnableConfig) => IO
  ): Promise<Runnable | undefined> {
    let result = await this.condition(reader ? reader(config) : input, config);
    if (!Array.isArray(result)) {
      result = [result];
    }

    let destinations: string[];
    if (this.ends) {
      destinations = result.map((r) => this.ends![r]);
    } else {
      destinations = result;
    }
    return writer(destinations);
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
      throw new Error(`Already found path for ${startKey}`);
    }

    this.edges.add([startKey, endKey]);

    return this;
  }

  addConditionalEdges(
    startKey: N,
    condition: Branch<RunInput, N>["condition"],
    conditionalEdgeMapping?: Record<string, N | typeof END>
  ): this {
    this.warnIfCompiled(
      "Adding an edge to a graph that has already been compiled. This will not be reflected in the compiled graph."
    );
    // find a name for condition
    const name = condition.name || "condition";
    // validate condition
    if (this.branches[startKey] && this.branches[startKey][name]) {
      throw new Error(
        `Condition \`${name}\` already present for node \`${startKey}\``
      );
    }
    // save it
    if (!this.branches[startKey]) {
      this.branches[startKey] = {};
    }
    this.branches[startKey][name] = new Branch(
      condition,
      conditionalEdgeMapping
    );
    return this;
  }

  setEntryPoint(key: N): this {
    this.warnIfCompiled(
      "Setting the entry point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    return this.addEdge(START, key);
  }

  setFinishPoint(key: N): this {
    this.warnIfCompiled(
      "Setting a finish point of a graph that has already been compiled. This will not be reflected in the compiled graph."
    );

    return this.addEdge(key, END);
  }

  compile(
    checkpointer?: BaseCheckpointSaver,
    interruptBefore?: N[] | All,
    interruptAfter?: N[] | All
  ): CompiledGraph<N> {
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
      inputs: START,
      outputs: END,
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
    for (const [start, branches] of Object.entries(this.branches)) {
      allSources.add(start);
      for (const branch of Object.values(branches)) {
        // TODO revise when adding branch.then
        if (branch.ends) {
          for (const end of Object.values(branch.ends)) {
            if (end !== END) {
              allSources.add(end);
            }
          }
        } else {
          for (const node of Object.keys(this.nodes)) {
            if (node !== start) {
              allSources.add(node);
            }
          }
        }
      }
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
        // TODO revise when adding branch.then
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
  builder: Graph<N, RunInput, RunOutput>;

  constructor({
    builder,
    ...rest
  }: { builder: Graph<N, RunInput, RunOutput> } & PregelInterface<
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
        const channels = dests.map((dest) =>
          dest === END ? END : `branch:${start}:${name}:${dest}`
        );
        return new ChannelWrite(
          channels.map((channel) => ({ channel, value: PASSTHROUGH })),
          [TAG_HIDDEN]
        );
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
}
