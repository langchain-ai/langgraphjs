import { Promiventerator } from "promiventerator";
import { BaseMessage } from "@langchain/core/messages";
import { StateDefinition, StateType, UpdateType } from "../graph/annotation.js";
import { Pregel } from "./index.js";
import { PregelNode } from "./read.js";
import {
  DebugEvent,
  LangGraphMetadata,
  MessagesEvent,
  PregelOptions,
  StreamMode,
  StrRecord,
} from "./types.js";
import { END, START } from "../constants.js";
import { BaseChannel } from "../channels/base.js";
import { ManagedValueSpec } from "../managed/base.js";

type ValuesEvent<T> = T extends StateDefinition ? StateType<T> : T;

type UpdatesEvent<Nodes extends StrRecord<string, PregelNode>> = {
  [K in keyof Omit<
    Nodes,
    typeof START | typeof END
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  >]: Nodes[K] extends PregelNode<any, infer Update> ? Update : never;
};

type StreamMapping<
  GraphOutputT,
  Nodes extends StrRecord<string, PregelNode>,
  CustomEventT = unknown
> = {
  values: ValuesEvent<GraphOutputT>;
  updates: UpdatesEvent<Nodes>;
  messages: MessagesEvent;
  custom: CustomEventT;
  debug: DebugEvent;
};

type NamespacedStreamMapping<
  GraphOutputT,
  Nodes extends StrRecord<string, PregelNode> = StrRecord<string, PregelNode>,
  CustomEventT = unknown
> = {
  values: Record<string, ValuesEvent<GraphOutputT>>;
  updates: Record<string, UpdatesEvent<Nodes>>;
  messages: Record<string, MessagesEvent>;
  custom: Record<string, CustomEventT>;
  debug: Record<string, DebugEvent>;
};

type StreamEvents<
  CustomEventT = unknown,
  GraphOutputT = unknown,
  Nodes extends StrRecord<string, PregelNode> = StrRecord<string, PregelNode>,
  StreamSubgraphsT extends boolean = false,
  StreamModeT extends StreamMode | readonly StreamMode[] = ["values"]
> = StreamSubgraphsT extends false
  ? StreamModeT extends StreamMode
    ? {
        // not streaming subgraphs, and user passed string literal stream mode
        [K in StreamModeT]: StreamMapping<GraphOutputT, Nodes, CustomEventT>[K];
      }
    : StreamModeT extends StreamMode[]
    ? {
        // not streaming subgraphs, and user passed array of stream modes
        [K in StreamModeT[number]]: StreamMapping<
          GraphOutputT,
          Nodes,
          CustomEventT
        >[K];
      }
    : {
        // default case StreamModeT extends undefined - ["values"]
        values: StreamMapping<GraphOutputT, Nodes, CustomEventT>["values"];
      }
  : StreamModeT extends StreamMode // from here on, we are streaming subgraphs
  ? {
      [K in StreamModeT]: NamespacedStreamMapping<
        GraphOutputT,
        Nodes,
        CustomEventT
      >[K];
    } // streaming subgraphs, and user passed string literal stream mode
  : StreamModeT extends StreamMode[]
  ? {
      [K in StreamModeT[number]]: NamespacedStreamMapping<
        GraphOutputT,
        Nodes,
        CustomEventT
      >[K];
    } // streaming subgraphs, and user passed array of stream modes
  : {
      values: NamespacedStreamMapping<
        GraphOutputT,
        Nodes,
        CustomEventT
      >["values"];
    }; // default case StreamModeT extends undefined - ["values"]

export type PregelExecConfig<
  Nodes extends StrRecord<string, PregelNode>,
  Channels extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  ConfigurableFieldType extends Record<string, unknown>,
  StreamModeT extends StreamMode | StreamMode[],
  StreamSubgraphsT extends boolean
> = Omit<
  Omit<PregelOptions<Nodes, Channels, ConfigurableFieldType>, "streamMode">,
  "subgraphs"
> & {
  /**
   * The stream mode for the graph run. See [Streaming](/langgraphjs/how-tos/#streaming) for more details.
   * @default ["values"]
   */
  streamMode?: StreamModeT;
  /**
   * Whether to stream subgraphs.
   * @default false
   */
  subgraphs?: StreamSubgraphsT;
};

export function exec<
  CustomEventT = unknown,
  Nodes extends StrRecord<string, PregelNode> = StrRecord<string, PregelNode>,
  Channels extends StrRecord<
    string,
    BaseChannel | ManagedValueSpec
  > = StrRecord<string, BaseChannel | ManagedValueSpec>,
  ConfigurableFieldType extends Record<string, unknown> = Record<
    string,
    unknown
  >,
  InputType = unknown,
  OutputType = unknown,
  StreamSubgraphsT extends boolean = false,
  StreamModeT extends StreamMode | StreamMode[] = ["values"]
>(
  p: Pregel<Nodes, Channels, ConfigurableFieldType, InputType, OutputType>,
  config?: PregelExecConfig<
    Nodes,
    Channels,
    ConfigurableFieldType,
    StreamModeT,
    StreamSubgraphsT
  >
): (
  input: InputType
) => Promiventerator<
  OutputType,
  StreamEvents<CustomEventT, OutputType, Nodes, StreamSubgraphsT, StreamModeT>
> {
  return (input: InputType) => {
    const pv = new Promiventerator<
      OutputType,
      StreamEvents<
        CustomEventT,
        OutputType,
        Nodes,
        StreamSubgraphsT,
        StreamModeT
      >
    >((resolve, reject) => {
      (async () => {
        const originalStreamMode = Array.isArray(config?.streamMode)
          ? config?.streamMode ?? ["values"] // null coalesce to make ts happy, not sure why it doesn't type narrow here
          : [config?.streamMode ?? "values"];

        const stream = await p.stream(input, {
          ...config,
          streamMode: originalStreamMode.includes("values")
            ? originalStreamMode
            : [...originalStreamMode, "values"],
        });

        const lastValue = [];
        for await (const chunk of stream) {
          if (chunk === undefined) {
            reject(new Error("Data structure error."));
          }
          if (config?.subgraphs) {
            const [namespace, mode, payload] = chunk as [
              string,
              StreamMode,
              unknown
            ];
            if (mode === "values") {
              if (lastValue.length === 0) {
                lastValue.push(payload as OutputType);
              } else {
                lastValue[0] = payload as OutputType;
              }
            }

            if ((originalStreamMode as StreamMode[]).includes(mode)) {
              if (mode === "messages") {
                const [message, metadata] = payload as [
                  BaseMessage,
                  LangGraphMetadata
                ];
                await pv.emit(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  mode as any,
                  {
                    [namespace]: {
                      message,
                      metadata,
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } as any
                );
              } else {
                await pv.emit(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  mode as any,
                  {
                    [namespace]: payload,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } as any
                );
              }
            }
          } else {
            // not streaming subgraphs
            const [mode, payload] = chunk as [StreamMode, unknown];

            if (mode === "values") {
              if (lastValue.length === 0) {
                lastValue.push(payload as OutputType);
              } else {
                lastValue[0] = payload as OutputType;
              }
            }

            if ((originalStreamMode as StreamMode[]).includes(mode)) {
              if (mode === "messages") {
                const [message, metadata] = payload as [
                  BaseMessage,
                  LangGraphMetadata
                ];
                await pv.emit(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  mode as any,
                  {
                    message,
                    metadata,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  } as any
                );
              } else {
                await pv.emit(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  mode as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  payload as any
                );
              }
            }
          }
        }

        if (lastValue.length) {
          return lastValue[0];
        }
        throw new Error("BUG: no `values` emitted during execution");
      })()
        .then(resolve)
        .catch(reject);
    });
    return pv;
  };
}
