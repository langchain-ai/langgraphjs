import { Metadata } from "./metadata.mts";
import { RunnableConfig } from "./runnableConfig.mts";

export interface AssistantVersion {
  assistant_id: string;
  version: number;
  graph_id: string;
  config: RunnableConfig;
  metadata: Metadata;
  created_at: Date;
  name: string | undefined;
}