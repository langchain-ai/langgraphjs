import { Promiventerator } from "promiventerator";
import { StateDefinition, StateType, UpdateType } from "../graph/annotation.js";
import { BaseChannel, ManagedValueSpec } from "../web.js";
import { StrRecord } from "./algo.js";
import { Pregel } from "./index.js";
import { PregelNode } from "./read.js";
import { PregelOptions, StreamMode } from "./types.js";

type Values<T> = T extends StateDefinition ? StateType<T> : T;
type Updates<T> = T extends StateDefinition ? UpdateType<T> : Partial<T>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Messages<_T> = unknown;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Custom<_T> = unknown;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Debug<_T> = unknown;

type StreamMapping<GraphOutputT> = {
  values: Values<GraphOutputT>;
  updates: Updates<GraphOutputT>;
  messages: Messages<GraphOutputT>;
  custom: Custom<GraphOutputT>;
  debug: Debug<GraphOutputT>;
};

type NamespacedStreamMapping<GraphOutputT> = {
  values: Record<string, Values<GraphOutputT>>;
  updates: Record<string, Updates<GraphOutputT>>;
  messages: Record<string, Messages<GraphOutputT>>;
  custom: Record<string, Custom<GraphOutputT>>;
  debug: Record<string, Debug<GraphOutputT>>;
};

type StreamEvents<
  GraphOutputT,
  StreamSubgraphsT extends boolean = false,
  StreamModeT extends StreamMode | readonly StreamMode[] = ["values"]
> = StreamSubgraphsT extends false
  ? StreamModeT extends StreamMode
    ? { [K in StreamModeT]: StreamMapping<GraphOutputT>[K] } // not streaming subgraphs, and user passed string literal stream mode
    : StreamModeT extends StreamMode[]
    ? { [K in StreamModeT[number]]: StreamMapping<GraphOutputT>[K] } // not streaming subgraphs, and user passed array of stream modes
    : { values: StreamMapping<GraphOutputT>["values"] } // default case StreamModeT extends undefined - ["values"]
  : StreamModeT extends StreamMode // from here on, we are streaming subgraphs
  ? { [K in StreamModeT]: NamespacedStreamMapping<GraphOutputT>[K] } // streaming subgraphs, and user passed string literal stream mode
  : StreamModeT extends StreamMode[]
  ? { [K in StreamModeT[number]]: NamespacedStreamMapping<GraphOutputT>[K] } // streaming subgraphs, and user passed array of stream modes
  : { values: NamespacedStreamMapping<GraphOutputT>["values"] }; // default case StreamModeT extends undefined - ["values"]

export type PregelExecConfig<
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  ConfigurableFieldType extends Record<string, unknown>,
  StreamModeT extends StreamMode | StreamMode[],
  StreamSubgraphsT extends boolean
> = Omit<
  Omit<PregelOptions<Nn, Cc, ConfigurableFieldType>, "streamMode">,
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
  Nn extends StrRecord<string, PregelNode>,
  Cc extends StrRecord<string, BaseChannel | ManagedValueSpec>,
  ConfigurableFieldType extends Record<string, unknown>,
  InputType,
  OutputType,
  StreamSubgraphsT extends boolean = false,
  StreamModeT extends StreamMode | StreamMode[] = ["values"]
>(
  p: Pregel<Nn, Cc, ConfigurableFieldType, InputType, OutputType>,
  config?: PregelExecConfig<
    Nn,
    Cc,
    ConfigurableFieldType,
    StreamModeT,
    StreamSubgraphsT
  >
): (
  input: InputType
) => Promiventerator<
  OutputType,
  StreamEvents<OutputType, StreamSubgraphsT, StreamModeT>
> {
  return (input: InputType) => {
    const pv = new Promiventerator<
      OutputType,
      StreamEvents<OutputType, StreamSubgraphsT, StreamModeT>
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
              await pv.emit(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mode as any,
                {
                  [namespace]: payload,
                } as never // never is weird here, but it makes the type checker happy /shrug
              );
            }
          } else {
            const [mode, payload] = chunk as [StreamMode, unknown];

            if (mode === "values") {
              if (lastValue.length === 0) {
                lastValue.push(payload as OutputType);
              } else {
                lastValue[0] = payload as OutputType;
              }
            }

            if ((originalStreamMode as StreamMode[]).includes(mode)) {
              await pv.emit(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mode as any,
                payload as never // never is weird here, but it makes the type checker happy /shrug
              );
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
