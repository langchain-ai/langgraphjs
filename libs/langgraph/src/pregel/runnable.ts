/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Runnable,
  RunnableConfig,
  RunnableInterface,
  RunnableLambda,
  RunnableMap,
} from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { CONFIG_KEY_STORE } from "../constants.js";

export interface InvokeExtraFields {
  store?: BaseStore;
}
interface RunnableInterfaceWithExtraInvoke<
  RunInput = any,
  RunOutput = any,
  CallOptions extends RunnableConfig = RunnableConfig
> extends RunnableInterface<RunInput, RunOutput, CallOptions> {
  invoke(
    input: RunInput,
    options?: Partial<CallOptions>,
    extra?: InvokeExtraFields
  ): Promise<RunOutput>;
}
type RunnableFuncWithExtraInvoke<RunInput, RunOutput> = (
  input: RunInput,
  options:
    | RunnableConfig
    | Record<string, any>
    | (Record<string, any> & RunnableConfig),
  extra?: InvokeExtraFields
) => RunOutput | Promise<RunOutput>;
type RunnableMapLikeWithExtraInvoke<RunInput, RunOutput> = {
  [K in keyof RunOutput]: RunnableLikeWithExtraInvoke<RunInput, RunOutput[K]>;
};

export type RunnableLikeWithExtraInvoke<RunInput = any, RunOutput = any> =
  | RunnableInterfaceWithExtraInvoke<RunInput, RunOutput>
  | RunnableFuncWithExtraInvoke<RunInput, RunOutput>
  | RunnableMapLikeWithExtraInvoke<RunInput, RunOutput>;

export abstract class RunnableWithOptions<
  RunInput = any,
  RunOutput = any,
  CallOptions extends RunnableConfig = RunnableConfig
> extends Runnable<RunInput, RunOutput, CallOptions> {
  abstract invoke(
    input: RunInput,
    options?: Partial<CallOptions>,
    extra?: InvokeExtraFields
  ): Promise<RunOutput>;
}


export function _coerceToRunnable<RunInput, RunOutput>(
  coerceable: RunnableLikeWithExtraInvoke<RunInput, RunOutput>
): Runnable<RunInput, Exclude<RunOutput, Error>> {
  if (typeof coerceable === "function") {
    return new RunnableLambda({ func: async (input: RunInput, config: RunnableConfig) => {
      const extra = {
        store: config?.configurable?.[CONFIG_KEY_STORE]?.store,
      };
      return coerceable(input, config, extra);
    } }) as Runnable<
      RunInput,
      Exclude<RunOutput, Error>
    >;
  } else if (Runnable.isRunnable(coerceable)) {
    return {
      invoke: async (input: RunInput, options?: Partial<RunnableConfig>) => {
        const extra = {
          store: options?.configurable?.[CONFIG_KEY_STORE]?.store,
        };
        return coerceable.invoke(input, options, extra);
      },
    } as Runnable<RunInput, Exclude<RunOutput, Error>>;
  } else if (!Array.isArray(coerceable) && typeof coerceable === "object") {
    const runnables: Record<string, Runnable<RunInput>> = {};
    for (const [key, value] of Object.entries(coerceable)) {
      runnables[key] = _coerceToRunnable(value as RunnableLikeWithExtraInvoke);
    }
    return {
      invoke: async (input: RunInput, options?: Partial<RunnableConfig>) => {
        const extra = {
          store: options?.configurable?.[CONFIG_KEY_STORE]?.store,
        };
        const runnableMap = new RunnableMap({
          steps: runnables,
        });
        return runnableMap.invoke(input, options, extra) as Exclude<RunOutput, Error>;
      },
    } as Runnable<RunInput, Exclude<RunOutput, Error>>;
  } else {
    throw new Error(
      `Expected a Runnable, function or object.\nInstead got an unsupported type.`
    );
  }
}