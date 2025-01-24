import {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Pregel } from "../pregel/index.js";
import { PregelNode } from "../pregel/read.js";
import { END, START } from "../graph/graph.js";
import { CONFIG_KEY_PREVIOUS, PREVIOUS } from "../constants.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { call, getRunnableForEntrypoint } from "../pregel/call.js";
import { RetryPolicy } from "../pregel/utils/index.js";
import { Promisified } from "../utils.js";
import { LastValue } from "../channels/last_value.js";
import {
  EntrypointFinal,
  EntrypointFuncReturnT,
  EntrypointFuncSaveT,
  finalSymbol,
} from "./types.js";
import { LangGraphRunnableConfig } from "../pregel/runnable_types.js";

/**
 * Options for the @see task function
 *
 * @experimental
 */
export type TaskOptions = {
  /**
   * The retry policy for the task
   */
  retry?: RetryPolicy;
};

/**
 * Wraps a function in a task that can be retried
 *
 *  !!! warning "Experimental"
 *      This is an experimental API that is subject to change.
 *      Do not use for production code.
 *
 * @experimental
 *
 * @param name - The name of the task, analagous to the node name in @see StateGraph
 * @param func - The function that executes this task
 * @param options.retry - The retry policy for the task
 * @returns A proxy function that accepts the same arguments as the original and always returns the result as a @see Promise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function task<FuncT extends (...args: any[]) => any>(
  name: string,
  func: FuncT,
  options?: TaskOptions
): (...args: Parameters<FuncT>) => Promisified<FuncT> {
  return (...args: Parameters<FuncT>) => {
    return call({ func, name, retry: options?.retry }, ...args);
  };
}

/**
 * Options for the @see entrypoint function
 *
 * @experimental
 */
export type EntrypointOptions = {
  /**
   * The name of the entrypoint, analagous to the node name in @see StateGraph
   *
   * @experimental
   */
  name: string;
  /**
   * The checkpointer for the entrypoint
   *
   * @experimental
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * The store for the entrypoint
   *
   * @experimental
   */
  store?: BaseStore;
};

/**
 * Creates an entrypoint that returns a Pregel instance
 *
 *  !!! warning "Experimental"
 *      This is an experimental API that is subject to change.
 *      Do not use for production code.
 *
 * @experimental
 *
 * @param options.name - The name of the entrypoint, analagous to the node name in @see StateGraph
 * @param options.checkpointer - The checkpointer for the entrypoint
 * @param func - The function that executes this entrypoint
 * @returns A Pregel instance that can be run
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function entrypoint<FuncT extends (...args: any[]) => any>(
  { name, checkpointer, store }: EntrypointOptions,
  func: FuncT
) {
  const p = new Pregel<
    Record<string, PregelNode<Parameters<FuncT>, EntrypointFuncReturnT<FuncT>>>,
    {
      [START]: EphemeralValue<Parameters<FuncT>>;
      [END]: LastValue<EntrypointFuncReturnT<FuncT>>;
      [PREVIOUS]: LastValue<EntrypointFuncSaveT<FuncT>>;
    },
    Record<string, unknown>,
    Parameters<FuncT>,
    EntrypointFuncReturnT<FuncT>
  >({
    checkpointer,
    nodes: {
      [name]: new PregelNode<Parameters<FuncT>, EntrypointFuncReturnT<FuncT>>({
        bound: getRunnableForEntrypoint(name, func),
        triggers: [START],
        channels: [START],
        writers: [],
      }),
    },
    channels: {
      [START]: new EphemeralValue<Parameters<FuncT>>(),
      [END]: new LastValue<EntrypointFuncReturnT<FuncT>>(),
      [PREVIOUS]: new LastValue<EntrypointFuncSaveT<FuncT>>(),
    },
    inputChannels: START,
    outputChannels: END,
    streamChannels: END,
    streamMode: "updates",
    store,
  });
  p.name = name;
  return p;
}

/**
 * A helper utility for use with the functional API that returns a value to the caller, as well as a separate state value to persist to the checkpoint
 *
 * @param value - The value to return to the caller
 * @param save - The value to save to the checkpoint
 * @returns An object with the value and save properties
 */
entrypoint.final = function final<ValueT, SaveT>({
  value,
  save,
}: {
  value?: ValueT;
  save?: SaveT;
}): EntrypointFinal<ValueT, SaveT> {
  return {
    [finalSymbol]: { value, save },
  };
};

/**
 * A helper utility function for use with the functional API that returns the previous state from the checkpoint from the last invocation of the current thread.
 *
 * Related: @see {@link entrypoint#final}
 *
 * @returns the previous saved state from the last invocation of the current thread.
 */
export function getPreviousState<StateT>(): StateT {
  const config: LangGraphRunnableConfig =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return config.configurable?.[CONFIG_KEY_PREVIOUS] as StateT;
}
