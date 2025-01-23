import {
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { Pregel } from "./pregel/index.js";
import { PregelNode } from "./pregel/read.js";
import { END, START } from "./graph/graph.js";
import { BaseChannel } from "./channels/base.js";
import { ChannelWrite, PASSTHROUGH } from "./pregel/write.js";
import { TAG_HIDDEN } from "./constants.js";
import { ManagedValueSpec } from "./managed/base.js";
import { EphemeralValue } from "./channels/ephemeral_value.js";
import { call, getRunnableForFunc } from "./pregel/call.js";
import { RetryPolicy } from "./pregel/utils/index.js";
import { Promisified } from "./utils.js";
import { LastValue } from "./channels/last_value.js";

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
): Pregel<
  Record<string, PregelNode>,
  Record<string, BaseChannel | ManagedValueSpec>,
  Record<string, unknown>,
  Parameters<FuncT>,
  ReturnType<FuncT>
> {
  const p = new Pregel<
    Record<string, PregelNode>,
    Record<string, BaseChannel | ManagedValueSpec>,
    Record<string, unknown>,
    Parameters<FuncT>,
    ReturnType<FuncT>
  >({
    checkpointer,
    nodes: {
      [name]: new PregelNode({
        bound: getRunnableForFunc(name, func, false),
        triggers: [START],
        channels: [START],
        writers: [
          new ChannelWrite(
            [{ channel: END, value: PASSTHROUGH }],
            [TAG_HIDDEN]
          ),
        ],
      }),
    },
    channels: {
      [START]: new EphemeralValue<Parameters<FuncT>>(),
      [END]: new LastValue<ReturnType<FuncT>>(),
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
