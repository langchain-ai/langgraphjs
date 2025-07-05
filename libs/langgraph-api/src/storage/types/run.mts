import { Metadata } from "./metadata.mjs";
import { RunCommand } from "../../command.mjs";
import { RunnableConfig } from "./runnableConfig.mjs";

export type RunStatus =
  | "pending"
  | "running"
  | "error"
  | "success"
  | "timeout"
  | "interrupted";

export type StreamMode =
  | "values"
  | "messages"
  | "messages-tuple"
  | "custom"
  | "updates"
  | "events"
  | "debug";

export type MultitaskStrategy = "reject" | "rollback" | "interrupt" | "enqueue";

export interface RunKwargs {
  input?: unknown;
  command?: RunCommand;

  stream_mode?: Array<StreamMode>;

  interrupt_before?: "*" | string[] | undefined;
  interrupt_after?: "*" | string[] | undefined;

  config?: RunnableConfig;

  subgraphs?: boolean;
  resumable?: boolean;

  temporary?: boolean;

  // TODO: implement webhook
  webhook?: unknown;

  // TODO: implement feedback_keys
  feedback_keys?: string[] | undefined;

  [key: string]: unknown;
}

export interface Run {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  created_at: Date;
  updated_at: Date;
  status: RunStatus;
  metadata: Metadata;
  kwargs: RunKwargs;
  multitask_strategy: MultitaskStrategy;
}
