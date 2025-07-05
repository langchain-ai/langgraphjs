import { Metadata } from "./metadata.mts";
import { RunnableConfig } from "./runnableConfig.mts";

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

export interface Thread {
  thread_id: string;
  created_at: Date;
  updated_at: Date;
  metadata?: Metadata;
  config?: RunnableConfig;
  status: ThreadStatus;
  values?: Record<string, unknown>;
  interrupts?: Record<string, unknown>;
}
