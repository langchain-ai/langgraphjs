import { RunnableConfig, RunnableInterface } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

type RunnableFunc<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig
> = (
  input: RunInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: CallOptions
) => RunOutput | Promise<RunOutput>;

type RunnableMapLike<RunInput, RunOutput> = {
  [K in keyof RunOutput]: RunnableLike<RunInput, RunOutput[K]>;
};

export type RunnableLike<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig
> =
  | RunnableInterface<RunInput, RunOutput, CallOptions>
  | RunnableFunc<RunInput, RunOutput, CallOptions>
  | RunnableMapLike<RunInput, RunOutput>;

type IsEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

export interface LangGraphRunnableConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = Record<string, any>,
  InterruptType = unknown,
  WriterType = unknown
> extends RunnableConfig<ContextType> {
  context?: ContextType;

  store?: BaseStore;

  writer?: IsEqual<WriterType, unknown> extends true
    ? (chunk: unknown) => void
    : WriterType;

  interrupt?: IsEqual<InterruptType, unknown> extends true
    ? (value: unknown) => unknown
    : InterruptType;
}

export interface Runtime<
  ContextType = Record<string, unknown>,
  InterruptType = unknown,
  WriterType = unknown
> {
  context?: ContextType;

  store?: BaseStore;

  writer?: IsEqual<WriterType, unknown> extends true
    ? (chunk: unknown) => void
    : WriterType;

  interrupt?: IsEqual<InterruptType, unknown> extends true
    ? (value: unknown) => unknown
    : InterruptType;

  signal?: AbortSignal;
}
