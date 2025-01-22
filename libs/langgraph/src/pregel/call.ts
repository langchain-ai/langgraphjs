import {
  Runnable,
  RunnableConfig,
  RunnableSequence,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { CONFIG_KEY_CALL, RETURN, TAG_HIDDEN } from "../constants.js";
import { ChannelWrite, PASSTHROUGH } from "./write.js";
import { RetryPolicy } from "./utils/index.js";
import { Promisified } from "./types.js";
import { RunnableCallable, type RunnableCallableArgs } from "../utils.js";

/**
 * Get a runnable sequence for a function that wraps it in a sequence with a RETURN channel write
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRunnableForFunc<FuncT extends (...args: any[]) => any>(
  name: string,
  func: FuncT,
  writeReturn: boolean = true
): Runnable<Parameters<FuncT>, ReturnType<FuncT>> {
  const run = new RunnableCallable<Parameters<FuncT>, ReturnType<FuncT>>({
    func: (input: Parameters<FuncT>) => func(...input),
    name,
    trace: false,
    recurse: false,
  } as RunnableCallableArgs);

  if (writeReturn) {
    // writes to return channel
    return new RunnableSequence<Parameters<FuncT>, ReturnType<FuncT>>({
      name,
      first: run,
      last: new ChannelWrite<ReturnType<FuncT>>(
        [{ channel: RETURN, value: PASSTHROUGH }],
        [TAG_HIDDEN]
      ),
      // TODO: add trace_inputs for task?
    });
  }

  return run;
}

export type CallWrapperOptions<FuncT extends (...args: unknown[]) => unknown> =
  {
    func: FuncT;
    name: string;
    retry?: RetryPolicy;
  };

export function call<FuncT extends (...args: unknown[]) => unknown>(
  { func, name, retry }: CallWrapperOptions<FuncT>,
  ...args: Parameters<FuncT>
): Promisified<FuncT> {
  const config =
    AsyncLocalStorageProviderSingleton.getRunnableConfig() as RunnableConfig;
  // TODO: type the CONFIG_KEY_CALL function
  if (typeof config.configurable?.[CONFIG_KEY_CALL] === "function") {
    return config.configurable[CONFIG_KEY_CALL](func, name, args, {
      retry,
      callbacks: config.callbacks,
    });
  }
  throw new Error("BUG: No CALL config found");
}
