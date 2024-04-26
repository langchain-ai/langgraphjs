import { RunnableLambda, RunnableLike } from "@langchain/core/runnables";
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

  // TODO: this doesn't dedupe edges as in py, so worth fixing at some point
  waitingEdges: Set<[string[], string]> = new Set();

  constructor(fields: StateGraphArgs<Channels>) {
    super();
    this.channels = _getChannels(fields.channels);
    for (const c of Object.values(this.channels)) {
      if (c.lc_graph_name === "BinaryOperatorAggregate") {
        this.supportMultipleEdges = true;
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

  addNode(key: string, action: RunnableLike) {
    if (key in this.channels) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }
    super.addNode(key, action);
  }

  addEdge(startKey: string | string[], endKey: string) {
    if (typeof startKey === "string") {
      super.addEdge(startKey, endKey);
      return;
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
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compile(checkpointer?: BaseCheckpointSaver<any>): Pregel {
    this.validate();

    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error("Cannot use channel names as node names");
    }

    const stateKeys = Object.keys(this.channels);
    const stateKeysRead =
      stateKeys.length === 1 && stateKeys[0] === "__root__"
        ? stateKeys[0]
        : stateKeys;
    let stateChannels: Record<string, string> | string = {};
    if (Array.isArray(stateKeysRead)) {
      for (const chan of stateKeys) {
        stateChannels[chan] = chan;
      }
    } else {
      stateChannels = stateKeysRead;
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

    for (const [key, node] of Object.entries(this.nodes)) {
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
      .pipe(Channel.writeTo(`${this.entryPoint}:inbox`));

    return new Pregel({
      nodes,
      channels: {
        ...this.channels,
        ...waitingEdgeChannels,
        ...nodeInboxes,
        ...nodeOutboxes,
        END: new LastValue(),
      },
      input: `${START}:inbox`,
      output: END,
      hidden: Object.keys(this.nodes)
        .map((node) => `${node}:inbox`)
        .concat(START, stateKeys),
      checkpointer,
    });
  }
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
