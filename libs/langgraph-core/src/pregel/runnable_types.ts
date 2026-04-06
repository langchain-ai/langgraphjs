import { RunnableConfig, RunnableInterface } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";

type RunnableFunc<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig,
> = (
  input: RunInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: CallOptions
) => RunOutput | Promise<RunOutput>;

type RunnableMapLike<RunInput, RunOutput> = {
  [K in keyof RunOutput]: RunnableLike<RunInput, RunOutput[K]>;
};

export type RunnableLike<
  RunInput,
  RunOutput,
  CallOptions extends RunnableConfig = RunnableConfig,
> =
  | RunnableInterface<RunInput, RunOutput, CallOptions>
  | RunnableFunc<RunInput, RunOutput, CallOptions>
  | RunnableMapLike<RunInput, RunOutput>;

type IsEqual<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

/** Read-only execution info/metadata for the execution of current thread/run/node. */
export interface ExecutionInfo {
  /** The checkpoint ID for the current execution. */
  readonly checkpointId: string;
  /** The checkpoint namespace for the current execution. */
  readonly checkpointNs: string;
  /** The task ID for the current execution. */
  readonly taskId: string;
  /** The thread ID for the current execution. Undefined when running without a checkpointer. */
  readonly threadId?: string;
  /** The run ID for the current execution. Undefined when `runId` is not provided in the config. */
  readonly runId?: string;
  /** Current node execution attempt number (1-indexed). */
  readonly nodeAttempt: number;
  /** Unix timestamp (ms) for when the first attempt started. */
  readonly nodeFirstAttemptTime?: number;
}

/** Metadata injected by LangGraph Server. Undefined when running open-source LangGraph without LangSmith deployments. */
export interface ServerInfo {
  /** The assistant ID for the current execution. */
  readonly assistantId: string;
  /** The graph ID for the current execution. */
  readonly graphId: string;
  /** The authenticated user, if any. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly user?: Record<string, any>;
}

export interface Runtime<
  ContextType = Record<string, unknown>,
  InterruptType = unknown,
  WriterType = unknown,
> {
  configurable?: ContextType;

  /** User provided context */
  context?: ContextType;

  /** Persistent key-value store */
  store?: BaseStore;

  /** Callback to send custom data chunks via the `custom` stream mode */
  writer: IsEqual<WriterType, unknown> extends true
    ? (chunk: unknown) => void
    : WriterType;

  /**
   * Interrupts the execution of a graph node.
   *
   * This function can be used to pause execution of a node, and return the value of the `resume`
   * input when the graph is re-invoked using `Command`.
   * Multiple interrupts can be called within a single node, and each will be handled sequentially.
   *
   * When an interrupt is called:
   * 1. If there's a `resume` value available (from a previous `Command`), it returns that value.
   * 2. Otherwise, it throws a `GraphInterrupt` with the provided value
   * 3. The graph can be resumed by passing a `Command` with a `resume` value
   *
   * Because the `interrupt` function propagates by throwing a special `GraphInterrupt` error,
   * you should avoid using `try/catch` blocks around the `interrupt` function,
   * or if you do, ensure that the `GraphInterrupt` error is thrown again within your `catch` block.
   *
   * @param value - The value to include in the interrupt.
   * @returns The `resume` value provided when the graph is re-invoked with a Command.
   */
  interrupt: IsEqual<InterruptType, unknown> extends true
    ? (value: unknown) => unknown
    : InterruptType;

  /** Abort signal to cancel the run. */
  signal: AbortSignal;

  /** Read-only execution information/metadata for the current node run. Undefined before task preparation. */
  executionInfo?: ExecutionInfo;

  /** Metadata injected by LangGraph Server. Undefined when running open-source LangGraph without LangSmith deployments. */
  serverInfo?: ServerInfo;
}

export interface LangGraphRunnableConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
>
  extends
    RunnableConfig<ContextType>,
    Partial<Runtime<ContextType, unknown, unknown>> {}
