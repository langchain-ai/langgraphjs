import {
  RunnableConfig,
  RunnableLambda,
  RunnableLike,
} from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { END, Graph } from "./graph.js";
import { LastValue } from "../channels/last_value.js";
import { ChannelWrite } from "../pregel/write.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { Pregel, Channel } from "../pregel/index.js";
import { ChannelInvoke, ChannelRead } from "../pregel/read.js";
import { NamedBarrierValue } from "../channels/named_barrier_value.js";

export const START = "__start__";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StateGraphArgs<Channels extends Record<string, any>> {
  channels:
    | {
        [K in keyof Channels]:
          | {
              value: BinaryOperator<Channels[K]> | null;
              default?: () => Channels[K];
            }
          | string;
      }
    | {
        value: BinaryOperator<unknown> | null;
        default?: () => unknown;
      };
}

export class StateGraph<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Channels extends Record<string, any>
> extends Graph<Channels> {
  channels: Record<string, BaseChannel>;

  w_edges: Set<[[string, ...string[]], string]> = new Set(); 

  constructor(fields: StateGraphArgs<Channels>) {
    super();
    this.channels = _getChannels(fields.channels);
  }

  get allEdges(): Set<[string, string]> {
    return new Set([
      ...this.edges, 
      ...Array.from(this.w_edges).flatMap(([starts, end]) => starts.map(start => [start, end] as [string, string]))
    ]); 
  }

  addNode(key: string, action: RunnableLike) {
    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }
    super.addNode(key, action);
  }

  addEdge(startKey: string | string[], endKey: string) {
    if (typeof startKey === "string") {
      super.addEdge(startKey, endKey);
    }

    if (this.compiled) {
        console.warn(
            "Adding an edge to a graph that has already been compiled. This will " +
            "not be reflected in the compiled graph."
        );
    }

    for (const start of startKey) {
      if (start === END) {
        throw new Error("END cannot be a start node");
      }
      // TODO:
      //   if start not in self.nodes:
      // raise ValueError(f"Need to add_node `{start}` first")
    }
    if (endKey === END) {
      throw new Error('END cannot be an end node')
    }
    // TODO(janvi): add this. 
    // if end_key not in self.nodes:
    // raise ValueError(f"Need to add_node `{end_key}` first")

    this.w_edges.add([startKey, endKey]);
  }

  compile(checkpointer?: BaseCheckpointSaver): Pregel {
    this.validate();

    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error("Cannot use channel names as node names");
    }

    const stateKeys = Object.keys(this.channels);
    const stateKeysRead =
      stateKeys.length === 1 && stateKeys[0] === "__root__"
        ? stateKeys[0]
        : stateKeys;
    const updateState = Array.isArray(stateKeysRead)
      ? (
          nodeName: string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: Record<string, any>,
          options?: { config?: RunnableConfig }
        ) => _updateStateObject(stateKeys, nodeName, input, options)
      : _updateStateRoot;
      
    const waitingEdges: Set<[string, string[], string]> = new Set();
    this.w_edges.forEach(([starts, end]) => {
      waitingEdges.add([`${starts}:${end}`, starts, end]);
    });

    const waitingEdgeChannels: { [key: string]: NamedBarrierValue<string> } = {};
    waitingEdges.forEach(([key, starts]) => {
        waitingEdgeChannels[key] = new NamedBarrierValue<string>(new Set(starts));
    });

    const outgoingEdges: Record<string, string[]> = {};
    for (const [start, end] of this.edges) {
      if (!outgoingEdges[start]) {
        outgoingEdges[start] = [];
      }
      outgoingEdges[start].push(end !== END ? `${end}:inbox` : END);
    }
    for (const [key, starts] of waitingEdges) {
      for (const start of starts) {
        if (!outgoingEdges[start]) {
          outgoingEdges[start] = [];
        }
        outgoingEdges[start].push(key);
      }
    }

    const nodes: Record<string, ChannelInvoke> = {};

    for (const [key, node] of Object.entries(this.nodes)) {
      const triggers = Array.from(waitingEdges).filter(([, , end]) => end === key).map(([chan]) => chan);

      nodes[key] = Channel.subscribeTo([`${key}:inbox`, ...triggers])
        .pipe(node)
        .pipe(
          (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            input: Record<string, any>,
            options?: { config?: RunnableConfig }
          ) => updateState(key, input, options)
        )
        .pipe(Channel.writeTo(key));
    }

    for (const key of Object.keys(this.nodes)) {
      const outgoing = outgoingEdges[key];
      const edgesKey = `${key}:edges`;
      if (outgoing || this.branches[key]) {
        nodes[edgesKey] = Channel.subscribeTo(key, {
          tags: ["langsmith:hidden"],
        }).pipe(new ChannelRead(stateKeysRead));
      }
      if (outgoing) {
        nodes[edgesKey] = nodes[edgesKey].pipe(Channel.writeTo(...outgoing));
      }
      if (this.branches[key]) {
        for (const branch of this.branches[key]) {
          nodes[edgesKey] = nodes[edgesKey].pipe(
            new RunnableLambda({
              func: (i, c) => branch.runnable(i, c),
            })
          );
        }
      }
    }

    nodes[START] = Channel.subscribeTo(`${START}:inbox`, {
      tags: ["langsmith:hidden"],
    })
      .pipe(
        (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input: Record<string, any>,
          options?: { config?: RunnableConfig }
        ) => updateState(START, input, options)
      )
      .pipe(Channel.writeTo(START));

    nodes[`${START}:edges`] = Channel.subscribeTo(START, {
      tags: ["langsmith:hidden"],
    })
      .pipe(new ChannelRead(stateKeysRead))
      .pipe(Channel.writeTo(`${this.entryPoint}:inbox`));

    return new Pregel({
      nodes,
      channels: this.channels,
      input: `${START}:inbox`,
      output: END,
      hidden: Object.keys(this.nodes)
        .map((node) => `${node}:inbox`)
        .concat(START, stateKeys),
      checkpointer,
    });
  }
}

function _updateStateObject(
  stateKeys: Array<string>,
  nodeName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  options?: { config?: RunnableConfig }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!options?.config) {
    throw new Error("Config not found when updating state.");
  }
  if (Object.keys(input).some((key) => !stateKeys.some((sk) => sk === key))) {
    throw new Error(
      `Invalid state update from node ${nodeName}, expected object with one or more of ${stateKeys.join(
        ", "
      )}, got ${Object.keys(input).join(",")}`
    );
  }
  ChannelWrite.doWrite(options.config, input);
  return input;
}

function _updateStateRoot(
  _nodeName: string,
  input: unknown,
  options?: { config?: RunnableConfig }
): unknown {
  if (!options?.config) {
    throw new Error("Config not found when updating state.");
  }
  ChannelWrite.doWrite(options.config, {
    __root__: input,
  });
  return input;
}

function _getChannels<Channels extends Record<string, unknown>>(
  schema: StateGraphArgs<Channels>["channels"]
): Record<string, BaseChannel> {
  if ("value" in schema && "default" in schema) {
    if (!schema.value) {
      throw new Error("Value is required for channels");
    }
    return {
      __root__: new BinaryOperatorAggregate<Channels["__root__"]>(
        schema.value as BinaryOperator<Channels["__root__"]>,
        schema.default as (() => Channels["__root__"]) | undefined
      ),
    };
  }
  const channels: Record<string, BaseChannel> = {};
  for (const [name, values] of Object.entries(schema)) {
    if (values.value) {
      channels[name] = new BinaryOperatorAggregate<Channels[typeof name]>(
        values.value,
        values.default
      );
    } else {
      channels[name] = new LastValue<typeof values.value>();
    }
  }
  return channels;
}
