import { RunnableConfig, RunnableInterface } from "@langchain/core/runnables";
import { BaseStore } from "@langchain/langgraph-checkpoint";
import { RunControl } from "./runtime.js";

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

  /**
   * Manually signal that the node is still making progress, resetting the
   * `idleTimeout` of the node's {@link TimeoutPolicy} (if configured).
   *
   * This is a no-op when the node has no `idleTimeout` configured. It is the
   * only progress signal when `refreshOn` is `"heartbeat"`, and is useful for
   * long-running work that doesn't otherwise emit writes, stream events, child
   * tasks, or callback events.
   */
  heartbeat?: () => void;

  /** Read-only execution information/metadata for the current node run. Undefined before task preparation. */
  executionInfo?: ExecutionInfo;

  /** Metadata injected by LangGraph Server. Undefined when running open-source LangGraph without LangSmith deployments. */
  serverInfo?: ServerInfo;

  /**
   * Run-scoped control plane for cooperative draining.
   *
   * Populated automatically during graph runs. Nodes can read
   * `runtime.control.drainRequested` / `drainReason`, or call
   * `runtime.control.requestDrain()` to ask the graph to stop at the next
   * superstep boundary. Undefined outside an active graph runtime.
   */
  control?: RunControl;
}

export interface LangGraphRunnableConfig<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ContextType extends Record<string, any> = Record<string, any>,
>
  extends
    RunnableConfig<ContextType>,
    Partial<Runtime<ContextType, unknown, unknown>> {}
