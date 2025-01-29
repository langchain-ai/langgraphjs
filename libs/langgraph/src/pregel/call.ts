import {
  Runnable,
  RunnableConfig,
  RunnableSequence,
} from "@langchain/core/runnables";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import {
  CONFIG_KEY_CALL,
  END,
  PREVIOUS,
  RETURN,
  TAG_HIDDEN,
} from "../constants.js";
import { ChannelWrite, PASSTHROUGH } from "./write.js";
import { RetryPolicy } from "./utils/index.js";
import { RunnableCallable, type RunnableCallableArgs } from "../utils.js";
import {
  EntrypointReturnT,
  finalSymbol,
  isEntrypointFinal,
} from "../func/types.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";
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

export function getRunnableForEntrypoint<InputT, OutputT>(
  name: string,
  func:
    | ((
        input: InputT,
        config: LangGraphRunnableConfig
      ) => Promise<EntrypointReturnT<OutputT>>)
    | ((input: InputT, config: LangGraphRunnableConfig) => OutputT)
): Runnable<InputT, EntrypointReturnT<OutputT>, LangGraphRunnableConfig> {
  const run = new RunnableCallable<InputT, EntrypointReturnT<OutputT>>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    func: (input: any, config: LangGraphRunnableConfig) => {
      return func(input, config);
    },
    name,
    trace: false,
    recurse: false,
  });

  return new RunnableSequence<InputT, EntrypointReturnT<OutputT>>({
    name,
    first: run,
    middle: [
      new ChannelWrite(
        [
          {
            channel: END,
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
      func: (final: EntrypointReturnT<typeof func>) =>
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function call<FuncT extends (...args: any[]) => any>(
  { func, name, retry }: CallWrapperOptions<FuncT>,
  ...args: Parameters<FuncT>
): Promise<ReturnType<FuncT>> {
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
