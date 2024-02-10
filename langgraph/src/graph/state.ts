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
import { ChannelRead } from "../pregel/read.js";

export const START = "__start__";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StateGraphArgs<Channels extends Record<string, any>> {
  channels:
    | {
        [K in keyof Channels]: {
          value: BinaryOperator<Channels[K]> | null;
          default?: () => Channels[K];
        };
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

  constructor(fields: StateGraphArgs<Channels>) {
    super();
    this.channels = _getChannels(fields.channels);
  }

  addNode(key: string, action: RunnableLike) {
    if (Object.keys(this.nodes).some((key) => key in this.channels)) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }
    super.addNode(key, action);
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
