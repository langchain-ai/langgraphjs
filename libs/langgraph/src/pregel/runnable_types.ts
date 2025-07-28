import { RunnableConfig, RunnableInterface } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

type RunnableFunc<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig
> = (
  input: RunInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: CallOptions | (Record<string, any> & CallOptions)
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
  ConfigurableType extends Record<string, any> = Record<string, any>
> extends RunnableConfig<ConfigurableType> {
  store?: BaseStore;

  writer?: (chunk: unknown) => void;
}
