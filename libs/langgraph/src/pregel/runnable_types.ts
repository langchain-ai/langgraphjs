import { RunnableConfig } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

export interface LangGraphRunnableConfig<
  ConfigurableType extends Record<string, any> = Record<string, any>
> extends RunnableConfig<ConfigurableType> {
  store?: BaseStore;
}
