/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Runnable,
  RunnableConfig,
  RunnableInterface,
} from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

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
