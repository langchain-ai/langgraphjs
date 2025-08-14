import { RunnableConfig } from "@langchain/core/runnables";

export const generateKey = (
  threadId: string,
  checkpointNamespace: string,
  checkpointId: string
) => {
  // return JSON.stringify([threadId, checkpointNamespace, checkpointId]);

  return `${threadId}__${checkpointNamespace}__${checkpointId}`;
};

export const getIdsFromRunnableConfig = (config: RunnableConfig) => {
  return {
    threadId: config.configurable?.thread_id,
    checkpointNamespace: config.configurable?.checkpoint_ns ?? "",
    checkpointId: config.configurable?.checkpoint_id,
  };
};

export { getCheckpointId } from "@langchain/langgraph-checkpoint";
