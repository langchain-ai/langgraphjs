import type {
  LangGraphRunnableConfig,
  CheckpointMetadata as LangGraphCheckpointMetadata,
} from "@langchain/langgraph";
import type { RunCommand } from "../command.mjs";

export type Metadata = Record<string, unknown>;

export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";

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
  | "debug"
  | "tasks"
  | "checkpoints";

export type MultitaskStrategy = "reject" | "rollback" | "interrupt" | "enqueue";

export type OnConflictBehavior = "raise" | "do_nothing";

export type IfNotExists = "create" | "reject";

export interface RunnableConfig {
  tags?: string[];

  recursion_limit?: number;

  configurable?: {
    thread_id?: string;
    thread_ts?: string;
    [key: string]: unknown;
  };

  metadata?: LangGraphRunnableConfig["metadata"];
}

export interface Assistant {
  name: string | undefined;
  assistant_id: string;
  graph_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  config: RunnableConfig;
  context: unknown;
  metadata: Metadata;
}

export interface AssistantVersion {
  assistant_id: string;
  version: number;
  graph_id: string;
  config: RunnableConfig;
  context: unknown;
  metadata: Metadata;
  created_at: Date;
  name: string | undefined;
}

export interface RunKwargs {
  input?: unknown;
  command?: RunCommand;

  stream_mode?: Array<StreamMode>;

  interrupt_before?: "*" | string[] | undefined;
  interrupt_after?: "*" | string[] | undefined;

  config?: RunnableConfig;
  context?: unknown;

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

export interface Store {
  runs: Record<string, Run>;
  threads: Record<string, Thread>;
  assistants: Record<string, Assistant>;
  assistant_versions: AssistantVersion[];
  retry_counter: Record<string, number>;
}

export interface Message {
  topic: `run:${string}:stream:${string}`;
  data: unknown;
}

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

export interface CheckpointTask {
  id: string;
  name: string;
  error?: string;
  interrupts: Record<string, unknown>;
  state?: RunnableConfig;
}

export interface CheckpointPayload {
  config?: RunnableConfig;
  metadata: LangGraphCheckpointMetadata;
  values: Record<string, unknown>;
  next: string[];
  parent_config?: RunnableConfig;
  tasks: CheckpointTask[];
}

export interface Checkpoint {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string | null;
  checkpoint_map: Record<string, unknown> | null;
}

export interface ThreadTask {
  id: string;
  name: string;
  error: string | null;
  interrupts: Record<string, unknown>[];
  checkpoint: Checkpoint | null;
  state: ThreadState | null;
  result: unknown | null;
}

export interface ThreadState {
  values: Record<string, unknown>;
  next: string[];
  checkpoint: Checkpoint | null;
  metadata: Record<string, unknown> | undefined;
  created_at: Date | null;
  parent_checkpoint: Checkpoint | null;
  tasks: ThreadTask[];
}
