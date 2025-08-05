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

export interface LangGraphRunnableConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = Record<string, any>
> extends RunnableConfig<ContextType> {
  context?: ContextType;

  store?: BaseStore;

  writer?: (chunk: unknown) => void;
}

export interface Runtime<ContextType = Record<string, unknown>> {
  context?: ContextType;

  store?: BaseStore;

  writer?: (chunk: unknown) => void;

  signal?: AbortSignal;
}
