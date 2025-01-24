import {
  Runnable,
  RunnableConfig,
  RunnableSequence,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { CONFIG_KEY_CALL, PREVIOUS, RETURN, TAG_HIDDEN } from "../constants.js";
import { ChannelWrite, PASSTHROUGH } from "./write.js";
import { RetryPolicy } from "./utils/index.js";
import { RunnableCallable, type RunnableCallableArgs } from "../utils.js";
import { Promisified } from "../utils.js";
import {
  EntrypointFuncReturnT,
  finalSymbol,
  isEntrypointFinal,
} from "../func/types.js";
/**
 * Wraps a user function in a Runnable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRunnableForFunc<FuncT extends (...args: any[]) => any>(
  name: string,
  func: FuncT
): Runnable<Parameters<FuncT>, ReturnType<FuncT>> {
  const run = new RunnableCallable<Parameters<FuncT>, ReturnType<FuncT>>({
    func: (input: Parameters<FuncT>) => func(...input),
    name,
    trace: false,
    recurse: false,
  } as RunnableCallableArgs);

  return new RunnableSequence<Parameters<FuncT>, ReturnType<FuncT>>({
    name,
    first: run,
    last: new ChannelWrite<ReturnType<FuncT>>(
      [{ channel: RETURN, value: PASSTHROUGH }],
      [TAG_HIDDEN]
    ),
  });
}

export function getRunnableForEntrypoint<
  FuncT extends (...args: unknown[]) => unknown
>(
  name: string,
  func: FuncT
): Runnable<Parameters<FuncT>, EntrypointFuncReturnT<FuncT>> {
  const run = new RunnableCallable<Parameters<FuncT>, ReturnType<FuncT>>({
    func: (input: Parameters<FuncT>) => func(...input),
    name,
    trace: false,
    recurse: false,
  } as RunnableCallableArgs);

  return new RunnableSequence<Parameters<FuncT>, EntrypointFuncReturnT<FuncT>>({
    name,
    first: run,
    middle: [
      new ChannelWrite(
        [
          {
            channel: "__end__",
            value: PASSTHROUGH,
            mapper: new RunnableCallable({
              func: (value) =>
                isEntrypointFinal(value) ? value[finalSymbol].value : value,
            }),
          },
        ],
        [TAG_HIDDEN]
      ),
      new ChannelWrite([
        {
          channel: PREVIOUS,
          value: PASSTHROUGH,
          mapper: new RunnableCallable({
            func: (value) => {
              return isEntrypointFinal(value) ? value[finalSymbol].save : value;
            },
          }),
        },
      ]),
    ],
    last: new RunnableCallable({
      func: (final: ReturnType<FuncT>) =>
        isEntrypointFinal(final) ? final[finalSymbol].value : final,
    }),
  });
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
