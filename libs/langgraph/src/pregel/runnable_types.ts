import { RunnableConfig } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

export interface LangGraphRunnableConfig extends RunnableConfig {
  store?: BaseStore;
}
