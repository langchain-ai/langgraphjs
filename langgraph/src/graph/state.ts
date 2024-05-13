import {
  Runnable,
  RunnableLambda,
  RunnableLike,
} from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { END, Graph } from "./graph.js";
import { LastValue } from "../channels/last_value.js";
import { ChannelWrite, PASSTHROUGH, SKIP_WRITE } from "../pregel/write.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { Pregel, Channel } from "../pregel/index.js";
import { PregelNode, ChannelRead } from "../pregel/read.js";
import { NamedBarrierValue } from "../channels/named_barrier_value.js";
import { AnyValue } from "../channels/any_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { RunnableCallable } from "../utils.js";

export const START = "__start__";

type SingleReducer<T> =
  | {
      reducer: BinaryOperator<T>;
      default?: () => T;
    }
  | {
      /**
       * @deprecated Use `reducer` instead
       */
      value: BinaryOperator<T>;
      default?: () => T;
    }
  | null;

export type ChannelReducers<Channels extends object> = {
  [K in keyof Channels]: SingleReducer<Channels[K]>;
};

export interface StateGraphArgs<Channels extends object | unknown> {
  channels: Channels extends object
    ? Channels extends unknown[]
      ? ChannelReducers<{ __root__: Channels }>
      : ChannelReducers<Channels>
    : ChannelReducers<{ __root__: Channels }>;
}

export class StateGraph<
  const State extends object | unknown,
  const Update extends object | unknown = Partial<State>,
  const N extends string = typeof START
> extends Graph<N, State, Update> {
  channels: Record<string, BaseChannel>;

  // TODO: this doesn't dedupe edges as in py, so worth fixing at some point
  waitingEdges: Set<[N[], N]> = new Set();

  constructor(fields: StateGraphArgs<State>) {
    super();
    this.channels = _getChannels(fields.channels);
    for (const c of Object.values(this.channels)) {
      if (c.lc_graph_name === "BinaryOperatorAggregate") {
        this.supportMultipleEdges = true;
        break;
      }
    }
  }

  get allEdges(): Set<[string, string]> {
    return new Set([
      ...this.edges,
      ...Array.from(this.waitingEdges).flatMap(([starts, end]) =>
        starts.map((start) => [start, end] as [string, string])
      ),
    ]);
  }

  addNode<K extends string>(
    key: K,
    action: RunnableLike<State, Update>
  ): StateGraph<State, Update, N | K> {
    if (key in this.channels) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }
    return super.addNode(key, action) as StateGraph<State, Update, N | K>;
  }

  addEdge(startKey: N | N[], endKey: N | typeof END): this {
    if (typeof startKey === "string") {
      return super.addEdge(startKey, endKey);
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
      if (!Object.keys(this.nodes).some((node) => node === start)) {
        throw new Error(`Need to add_node ${start} first`);
      }
    }
    if (endKey === END) {
      throw new Error("END cannot be an end node");
    }
    if (!Object.keys(this.nodes).some((node) => node === endKey)) {
      throw new Error(`Need to add_node ${endKey} first`);
    }

    this.waitingEdges.add([startKey, endKey]);

    return this;
  }

  compile(checkpointer?: BaseCheckpointSaver) {
    this.validate();

    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error("Cannot use channel names as node names");
    }

    const stateKeys = Object.keys(this.channels);
    const stateKeysRead =
      stateKeys.length === 1 && stateKeys[0] === "__root__"
        ? stateKeys[0]
        : stateKeys;
    let stateChannels: Record<string, string> | string[] = {};
    if (Array.isArray(stateKeysRead)) {
      for (const chan of stateKeys) {
        stateChannels[chan] = chan;
      }
    } else {
      stateChannels = [stateKeysRead];
    }

    const getInputKey = (key: string, input: unknown) => {
      if (!input) {
        return SKIP_WRITE;
      }
      if (typeof input !== "object") {
        throw new Error(`Invalid state update, expected dict and got ${input}`);
      }
      if (key in input) {
        return (input as Record<string, unknown>)[key];
      }
      return SKIP_WRITE;
    };

    const updateChannels = Array.isArray(stateKeysRead)
      ? stateKeysRead.map((key) => ({
          channel: key,
          value: PASSTHROUGH,
          skipNone: false,
          mapper: new RunnableCallable({
            func: (input) => getInputKey(key, input),
            trace: false,
            recurse: false,
          }),
        }))
      : [{ channel: "__root__", value: PASSTHROUGH, skipNone: true }];

    const waitingEdges: Set<[string, string[], string]> = new Set();
    this.waitingEdges.forEach(([starts, end]) => {
      waitingEdges.add([`${starts}:${end}`, starts, end]);
    });

    const waitingEdgeChannels: { [key: string]: NamedBarrierValue<string> } =
      {};
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

    const nodes: Record<string, PregelNode> = {};

    for (const [key, node] of Object.entries<Runnable<State, Update>>(
      this.nodes
    )) {
      const triggers = [
        `${key}:inbox`,
        ...Array.from(waitingEdges)
          .filter(([, , end]) => end === key)
          .map(([chan]) => chan),
      ];
      nodes[key] = new PregelNode({
        triggers,
        channels: stateChannels,
      })
        .pipe(node)
        .pipe(
          new ChannelWrite([
            { channel: key, value: PASSTHROUGH, skipNone: false },
            ...updateChannels,
          ])
        );
    }

    const nodeInboxes: Record<string, Channel> = {};
    const nodeOutboxes: Record<string, Channel> = {};
    for (const key of [...Object.keys(this.nodes), START]) {
      nodeInboxes[`${key}:inbox`] = new AnyValue();
      nodeOutboxes[key] = new EphemeralValue(); // we clear outbox channels after each step
    }

    for (const key of Object.keys(this.nodes)) {
      const outgoing = outgoingEdges[key];
      const edgesKey = `${key}:edges`;
      if (outgoing || this.branches[key]) {
        nodes[edgesKey] = new PregelNode({
          triggers: [key],
          tags: ["langsmith:hidden"],
          channels: stateChannels,
        }).pipe(new ChannelRead(stateKeysRead));
      }
      if (outgoing) {
        nodes[edgesKey] = nodes[edgesKey].pipe(
          new ChannelWrite(
            outgoing.map((dest) => ({
              channel: dest,
              value: dest === END ? PASSTHROUGH : key,
              skipNone: false,
            }))
          )
        );
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
    }).pipe(
      new ChannelWrite([
        { channel: START, value: PASSTHROUGH, skipNone: false },
        ...updateChannels,
      ])
    );

    nodes[`${START}:edges`] = new PregelNode({
      triggers: [START],
      tags: ["langsmith:hidden"],
      channels: stateChannels,
    })
      .pipe(new ChannelRead(stateKeysRead))
      .pipe(Channel.writeTo([`${this.entryPoint}:inbox`]));

    const channels: Record<string, BaseChannel> = {
      ...this.channels,
      ...waitingEdgeChannels,
      ...nodeInboxes,
      ...nodeOutboxes,
      [END]: new LastValue(),
    };

    return new Pregel({
      nodes,
      channels,
      inputs: `${START}:inbox`,
      outputs: END,
      checkpointer,
    });
  }
}

function _getChannels<Channels extends Record<string, unknown> | unknown>(
  schema: StateGraphArgs<Channels>["channels"]
): Record<string, BaseChannel> {
  const channels: Record<string, BaseChannel> = {};
  for (const [name, val] of Object.entries(schema)) {
    if (name === "__root__") {
      channels[name] = getChannel<Channels>(val as SingleReducer<Channels>);
    } else {
      const key = name as keyof Channels;
      channels[name] = getChannel<Channels[typeof key]>(
        val as SingleReducer<Channels[typeof key]>
      );
    }
  }
  return channels;
}

function getChannel<T>(reducer: SingleReducer<T>): BaseChannel<T> {
  if (reducer && "reducer" in reducer && reducer.reducer) {
    return new BinaryOperatorAggregate<T>(reducer.reducer, reducer.default);
  }
  if (reducer && "value" in reducer && reducer.value) {
    return new BinaryOperatorAggregate<T>(reducer.value, reducer.default);
  }
  return new LastValue<T>();
}
