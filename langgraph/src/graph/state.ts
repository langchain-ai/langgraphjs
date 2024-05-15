/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  Runnable,
  RunnableConfig,
  RunnableLike,
} from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { END, CompiledGraph, Graph, START, Branch } from "./graph.js";
import { LastValue } from "../channels/last_value.js";
import {
  ChannelWrite,
  ChannelWriteEntry,
  PASSTHROUGH,
  SKIP_WRITE,
} from "../pregel/write.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { ChannelRead, PregelNode } from "../pregel/read.js";
import { NamedBarrierValue } from "../channels/named_barrier_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { RunnableCallable } from "../utils.js";
import { All } from "../pregel/types.js";
import { TAG_HIDDEN } from "../constants.js";
import { InvalidUpdateError } from "../errors.js";

const ROOT = "__root__";

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

  addEdge(startKey: typeof START | N | N[], endKey: N | typeof END): this {
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

  compile({
    checkpointer,
    interruptBefore,
    interruptAfter,
  }: {
    checkpointer?: BaseCheckpointSaver;
    interruptBefore?: N[] | All;
    interruptAfter?: N[] | All;
  } = {}): CompiledStateGraph<State, Update, N> {
    // validate the graph
    this.validate([
      ...(Array.isArray(interruptBefore) ? interruptBefore : []),
      ...(Array.isArray(interruptAfter) ? interruptAfter : []),
    ]);

    // prepare output channels
    const stateKeys = Object.keys(this.channels);
    const outputs =
      stateKeys.length === 1 && stateKeys[0] === ROOT
        ? stateKeys[0]
        : stateKeys;

    // create empty compiled graph
    const compiled = new CompiledStateGraph({
      builder: this,
      checkpointer,
      interruptAfter,
      interruptBefore,
      autoValidate: false,
      nodes: {} as Record<N | typeof START, PregelNode<State, Update>>,
      channels: {
        ...this.channels,
        [START]: new EphemeralValue(),
      } as Record<N | typeof START | typeof END | string, BaseChannel>,
      inputs: START,
      outputs,
      streamChannels: outputs,
      streamMode: "updates",
    });

    // attach nodes, edges and branches
    compiled.attachNode(START);
    for (const [key, node] of Object.entries<Runnable<State, Update>>(
      this.nodes
    )) {
      compiled.attachNode(key as N, node);
    }
    for (const [start, end] of this.edges) {
      compiled.attachEdge(start, end);
    }
    for (const [starts, end] of this.waitingEdges) {
      compiled.attachEdge(starts, end);
    }
    for (const [start, branches] of Object.entries(this.branches)) {
      for (const [name, branch] of Object.entries(branches)) {
        compiled.attachBranch(start as N, name, branch);
      }
    }

    return compiled.validate();
  }
}

function _getChannels<Channels extends Record<string, unknown> | unknown>(
  schema: StateGraphArgs<Channels>["channels"]
): Record<string, BaseChannel> {
  const channels: Record<string, BaseChannel> = {};
  for (const [name, val] of Object.entries(schema)) {
    if (name === ROOT) {
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

export class CompiledStateGraph<
  const State extends object | unknown,
  const Update extends object | unknown = Partial<State>,
  const N extends string = typeof START
> extends CompiledGraph<N, State, Update> {
  declare builder: StateGraph<State, Update, N>;

  attachNode(key: typeof START, node?: never): void;

  attachNode(key: N, node: Runnable<State, Update, RunnableConfig>): void;

  attachNode(
    key: N | typeof START,
    node?: Runnable<State, Update, RunnableConfig>
  ): void {
    const stateKeys = Object.keys(this.builder.channels);

    function getStateKey(key: keyof Update, input: Update) {
      if (!input) {
        return SKIP_WRITE;
      } else if (typeof input !== "object" || Array.isArray(input)) {
        throw new InvalidUpdateError(`Expected dict, got ${typeof input}`);
      } else {
        return key in input ? input[key] : SKIP_WRITE;
      }
    }

    // state updaters
    const stateWriteEntries: ChannelWriteEntry[] = stateKeys.map((key) =>
      key === ROOT
        ? { channel: key, value: PASSTHROUGH, skipNone: true }
        : {
            channel: key,
            value: PASSTHROUGH,
            mapper: new RunnableCallable({
              func: getStateKey.bind(null, key as keyof Update),
              trace: false,
              recurse: false,
            }),
          }
    );

    // add node and output channel
    if (key === START) {
      this.nodes[key] = new PregelNode<State, Update>({
        tags: [TAG_HIDDEN],
        triggers: [START],
        channels: [START],
        writers: [new ChannelWrite(stateWriteEntries, [TAG_HIDDEN])],
      });
    } else {
      this.channels[key] = new EphemeralValue();
      this.nodes[key] = new PregelNode<State, Update>({
        triggers: [],
        // read state keys
        channels:
          stateKeys.length === 1 && stateKeys[0] === ROOT
            ? stateKeys
            : stateKeys.reduce((acc, k) => {
                acc[k] = k;
                return acc;
              }, {} as Record<string, string>),
        // publish to this channel and state keys
        writers: [
          new ChannelWrite(
            stateWriteEntries.concat({ channel: key, value: key }),
            [TAG_HIDDEN]
          ),
        ],
        bound: node,
      });
    }
  }

  attachEdge(start: N | N[] | "__start__", end: N | "__end__"): void {
    if (end === END) {
      return;
    }
    if (Array.isArray(start)) {
      const channelName = `join:${start.join("+")}:${end}`;
      // register channel
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new NamedBarrierValue(new Set(start));
      // subscribe to channel
      this.nodes[end].triggers.push(channelName);
      // publish to channel
      for (const s of start) {
        this.nodes[s].writers.push(
          new ChannelWrite([{ channel: channelName, value: s }], [TAG_HIDDEN])
        );
      }
    } else if (start === START) {
      const channelName = `start:${end}`;
      // register channel
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new EphemeralValue();
      // subscribe to channel
      this.nodes[end].triggers.push(channelName);
      // publish to channel
      this.nodes[START].writers.push(
        new ChannelWrite([{ channel: channelName, value: START }], [TAG_HIDDEN])
      );
    } else {
      this.nodes[end].triggers.push(start);
    }
  }

  attachBranch(
    start: N | typeof START,
    name: string,
    branch: Branch<State, N>
  ): void {
    // attach branch publisher
    this.nodes[start].writers.push(
      branch.compile(
        // writer
        (dests) => {
          const filteredDests = dests.filter((dest) => dest !== END);
          if (!filteredDests.length) {
            return;
          }
          const writes: ChannelWriteEntry[] = filteredDests.map((dest) => ({
            channel: `branch:${start}:${name}:${dest}`,
            value: start,
          }));
          // TODO implement branch.then
          return new ChannelWrite(writes, [TAG_HIDDEN]);
        },
        // reader
        (config) => ChannelRead.doRead<State>(config, this.outputs, true)
      )
    );

    // attach branch subscribers
    const ends = branch.ends
      ? Object.values(branch.ends)
      : Object.keys(this.builder.nodes);
    for (const end of ends) {
      if (end === END) {
        continue;
      }
      const channelName = `branch:${start}:${name}:${end}`;
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new EphemeralValue();
      this.nodes[end as N].triggers.push(channelName);
    }

    // TODO: implement branch.then
  }
}
