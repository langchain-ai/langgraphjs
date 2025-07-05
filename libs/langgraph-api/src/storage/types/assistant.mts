import { Metadata } from "./metadata.mjs";
import { RunnableConfig } from "./runnableConfig.mjs";

export interface Assistant {
  name: string | undefined;
  assistant_id: string;
  graph_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  config: RunnableConfig;
  metadata: Metadata;
}