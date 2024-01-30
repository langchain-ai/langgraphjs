import { RunnableConfig, RunnableLambda } from "@langchain/core/runnables";
import { BaseChannel } from "../channels/base.js";
import { BinaryOperator, BinaryOperatorAggregate } from "../channels/binop.js";
import { END, Graph } from "./graph.js";
import { LastValue } from "../channels/last_value.js";
import { ChannelWrite } from "../pregel/write.js";
import { BaseCheckpointSaver } from "../checkpoint/base.js";
import { Pregel, Channel } from "../pregel/index.js";
import { ChannelRead } from "../pregel/read.js";

export const START = "__start__";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StateGraphArgs<Channels extends Record<string, any>> {
  channels: {
    [K in keyof Channels]: {
      value: BinaryOperator<Channels[K]> | null;
      default?: () => Channels[K];
    };
  };
}

export class StateGraph<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Channels extends Record<string, any>
> extends Graph<Channels> {
  channels: Record<string, BaseChannel>;

  constructor(fields: StateGraphArgs<Channels>) {
    super();
    this.channels = _getChannels(fields.channels);
  }

  compile(checkpointer?: BaseCheckpointSaver): Pregel {
    this.validate();

    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error("Cannot use channel names as node names");
    }

    const stateKeys = Object.keys(this.channels);

    const outgoingEdges: Record<string, string[]> = {};
    for (const [start, end] of this.edges) {
      if (!outgoingEdges[start]) {
        outgoingEdges[start] = [];
      }
      outgoingEdges[start].push(end !== END ? `${end}:inbox` : END);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes: Record<string, any> = {};

    for (const [key, node] of Object.entries(this.nodes)) {
      nodes[key] = Channel.subscribeTo(`${key}:inbox`)
        .pipe(node)
        .pipe(_updateState)
        .pipe(Channel.writeTo(key));
    }

    for (const key of Object.keys(this.nodes)) {
      const outgoing = outgoingEdges[key];
      const edgesKey = `${key}:edges`;
      if (outgoing || this.branches[key]) {
        nodes[edgesKey] = Channel.subscribeTo(key, {
          tags: ["langsmith:hidden"],
        }).pipe(new ChannelRead(stateKeys));
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
      .pipe(_updateState)
      .pipe(Channel.writeTo(START));

    nodes[`${START}:edges`] = Channel.subscribeTo(START, {
      tags: ["langsmith:hidden"],
    })
      .pipe(new ChannelRead(stateKeys))
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

function _updateState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  options?: { config?: RunnableConfig }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!options?.config) {
    throw new Error("Config not found when updating state.");
  }
  ChannelWrite.doWrite(options.config, input);
  return input;
}

function _getChannels<Channels extends Record<string, unknown>>(
  schema: StateGraphArgs<Channels>["channels"]
): Record<string, BaseChannel> {
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
