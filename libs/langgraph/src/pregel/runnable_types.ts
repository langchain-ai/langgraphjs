import { RunnableConfig } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

export interface LangGraphRunnableConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfigurableType extends Record<string, any> = Record<string, any>
> extends RunnableConfig<ConfigurableType> {
  store?: BaseStore;

  writer?: (chunk: unknown) => void;
}
