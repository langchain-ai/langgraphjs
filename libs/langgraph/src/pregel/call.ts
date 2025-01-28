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
  EntrypointFunc,
  EntrypointReturnT,
  isEntrypointFinal,
  TaskFunc,
} from "../func/types.js";
import { LangGraphRunnableConfig } from "./runnable_types.js";

/**
 * Wraps a user function in a Runnable that writes the returned value to the RETURN channel.
 */
export function getRunnableForFunc<ArgsT extends unknown[], OutputT>(
  name: string,
  func: TaskFunc<ArgsT, OutputT>
): Runnable<ArgsT, OutputT, LangGraphRunnableConfig> {
  const run = new RunnableCallable<ArgsT, OutputT>({
    func: (input: ArgsT) => func(...input),
    name,
    trace: false,
    recurse: false,
  } as RunnableCallableArgs);

  return new RunnableSequence<ArgsT, OutputT>({
    name,
    first: run,
    last: new ChannelWrite<OutputT>(
      [{ channel: RETURN, value: PASSTHROUGH }],
      [TAG_HIDDEN]
    ),
  });
}

export function getRunnableForEntrypoint<InputT, OutputT>(
  name: string,
  func: EntrypointFunc<InputT, OutputT>
): Runnable<InputT, EntrypointReturnT<OutputT>, LangGraphRunnableConfig> {
  const run = new RunnableCallable<InputT, EntrypointReturnT<OutputT>>({
    func: (input: InputT, config: LangGraphRunnableConfig) => {
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
              func: (value) => (isEntrypointFinal(value) ? value.value : value),
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
              return isEntrypointFinal(value) ? value.save : value;
            },
          }),
        },
      ]),
    ],
    last: new RunnableCallable({
      func: (final: EntrypointReturnT<typeof func>) =>
        isEntrypointFinal(final) ? final.value : final,
    }),
  });
}

export type CallWrapperOptions<ArgsT extends unknown[], OutputT> = {
  func: TaskFunc<ArgsT, OutputT>;
  name: string;
  retry?: RetryPolicy;
};

export function call<ArgsT extends unknown[], OutputT>(
  { func, name, retry }: CallWrapperOptions<ArgsT, OutputT>,
  ...args: ArgsT
): Promise<OutputT> {
  const config =
    AsyncLocalStorageProviderSingleton.getRunnableConfig() as RunnableConfig;
  if (typeof config.configurable?.[CONFIG_KEY_CALL] === "function") {
    return config.configurable[CONFIG_KEY_CALL](func, name, args, {
      retry,
      callbacks: config.callbacks,
    });
  }
  throw new Error(
    "Async local storage not initialized. Please call initializeAsyncLocalStorageSingleton() before using this function."
  );
}
