import { Command, Interrupt } from "./constants.js";

// When editing, make sure to update the index found here:
// https://langchain-ai.github.io/langgraphjs/troubleshooting/errors/
export type BaseLangGraphErrorFields = {
  lc_error_code?:
    | "GRAPH_RECURSION_LIMIT"
    | "INVALID_CONCURRENT_GRAPH_UPDATE"
    | "INVALID_GRAPH_NODE_RETURN_VALUE"
    | "MISSING_CHECKPOINTER"
    | "MULTIPLE_SUBGRAPHS"
    | "UNREACHABLE_NODE";
};

// TODO: Merge with base LangChain error class when we drop support for core@0.2.0
/** @category Errors */
export class BaseLangGraphError extends Error {
  lc_error_code?: string;

  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    let finalMessage = message ?? "";
    if (fields?.lc_error_code) {
      finalMessage = `${finalMessage}\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langgraph/${fields.lc_error_code}/\n`;
    }
    super(finalMessage);
    this.lc_error_code = fields?.lc_error_code;
  }
}

export class GraphBubbleUp extends BaseLangGraphError {
  get is_bubble_up() {
    return true;
  }
}

export class GraphRecursionError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "GraphRecursionError";
  }

  static get unminifiable_name() {
    return "GraphRecursionError";
  }
}

export class GraphValueError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "GraphValueError";
  }

  static get unminifiable_name() {
    return "GraphValueError";
  }
}

/**
 * Raised when a graph run exits early due to a drain request.
 *
 * This indicates the graph stopped cooperatively at a superstep boundary
 * because {@link RunControl#requestDrain} was called (e.g., in response to
 * SIGTERM). The checkpoint is saved and the run can be resumed later.
 */
export class GraphDrained extends GraphBubbleUp {
  reason: string;

  constructor(reason: string = "shutdown", fields?: BaseLangGraphErrorFields) {
    super(`Graph drained: ${reason}`, fields);
    this.name = "GraphDrained";
    this.reason = reason;
  }

  static get unminifiable_name() {
    return "GraphDrained";
  }
}

export function isGraphDrained(e?: unknown): e is GraphDrained {
  return (
    e !== undefined && (e as Error).name === GraphDrained.unminifiable_name
  );
}

export class GraphInterrupt extends GraphBubbleUp {
  interrupts: Interrupt[];

  constructor(interrupts?: Interrupt[], fields?: BaseLangGraphErrorFields) {
    super(JSON.stringify(interrupts, null, 2), fields);
    this.name = "GraphInterrupt";
    this.interrupts = interrupts ?? [];
  }

  static get unminifiable_name() {
    return "GraphInterrupt";
  }
}

/** Raised by a node to interrupt execution. */
export class NodeInterrupt extends GraphInterrupt {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(message: any, fields?: BaseLangGraphErrorFields) {
    super([{ value: message }], fields);
    this.name = "NodeInterrupt";
  }

  static get unminifiable_name() {
    return "NodeInterrupt";
  }
}

/**
 * Failure context passed to a node-level error handler.
 *
 * A node-level error handler is registered via
 * `StateGraph.addNode(name, fn, { errorHandler })`. The handler runs ONLY after
 * the failing node's {@link RetryPolicy} is exhausted, so retry and handling
 * stay decoupled. The handler receives the failed node's name and the thrown
 * error via a `NodeError` instance, can return a state update, and can route to
 * a recovery branch via `new Command({ goto })` (saga / compensation flows).
 *
 * @example
 * ```ts
 * import { NodeError } from "@langchain/langgraph";
 *
 * function handler(state: State, error: NodeError) {
 *   return new Command({
 *     update: { status: `recovered from ${error.node}: ${error.error.message}` },
 *     goto: "finalize",
 *   });
 * }
 * ```
 */
export class NodeError {
  /** Name of the node whose execution failed. */
  node: string;

  /** Error thrown by the failed node. */
  error: Error;

  constructor(node: string, error: Error) {
    this.node = node;
    this.error = error;
  }

  static get unminifiable_name() {
    return "NodeError";
  }
}

/**
 * Type guard that checks whether a value is a {@link NodeError}.
 */
export function isNodeError(e?: unknown): e is NodeError {
  return (
    e != null &&
    typeof e === "object" &&
    e.constructor != null &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e.constructor as any).unminifiable_name === NodeError.unminifiable_name
  );
}

export class ParentCommand extends GraphBubbleUp {
  command: Command;

  constructor(command: Command) {
    super();
    this.name = "ParentCommand";
    this.command = command;
  }

  static get unminifiable_name() {
    return "ParentCommand";
  }
}

export function isParentCommand(e?: unknown): e is ParentCommand {
  return (
    e !== undefined &&
    (e as ParentCommand).name === ParentCommand.unminifiable_name
  );
}

export function isGraphBubbleUp(e?: unknown): e is GraphBubbleUp {
  return e !== undefined && (e as GraphBubbleUp).is_bubble_up === true;
}

export function isGraphInterrupt(e?: unknown): e is GraphInterrupt {
  return (
    e !== undefined &&
    [
      GraphInterrupt.unminifiable_name,
      NodeInterrupt.unminifiable_name,
    ].includes((e as Error).name)
  );
}

/**
 * Raised when a node invocation exceeds one of its configured timeouts.
 *
 * Does **not** extend {@link GraphBubbleUp} (so it flows through the normal node
 * error path) and is intentionally treated as retryable by the default retry
 * policy — its message/name do not match the default `retryOn` blocklist, so a
 * configured {@link RetryPolicy} will retry it (see langchain-ai/langgraph#7659).
 *
 * Both {@link NodeTimeoutError.runTimeout} and {@link NodeTimeoutError.idleTimeout}
 * reflect the configured policy at the time of the failure (each `undefined` if
 * not configured). {@link NodeTimeoutError.kind} and {@link NodeTimeoutError.timeout}
 * identify which one fired.
 *
 * @category Errors
 */
export class NodeTimeoutError extends BaseLangGraphError {
  /** Name of the node/task that timed out. */
  node: string;

  /** Which timeout fired: a hard `"run"` cap or a progress-resetting `"idle"` cap. */
  kind: "run" | "idle";

  /** The value (ms) of the timeout that fired (`runTimeout` or `idleTimeout`). */
  timeout: number;

  /** Elapsed time (ms) since the attempt started, at the moment the timeout fired. */
  elapsed: number;

  /** Configured run timeout (ms), if any. */
  runTimeout?: number;

  /** Configured idle timeout (ms), if any. */
  idleTimeout?: number;

  constructor(
    fields: {
      node: string;
      elapsed: number;
      kind: "run" | "idle";
      runTimeout?: number;
      idleTimeout?: number;
    },
    errorFields?: BaseLangGraphErrorFields
  ) {
    const { node, elapsed, kind, runTimeout, idleTimeout } = fields;
    let message: string;
    let timeout: number;
    if (kind === "idle") {
      if (idleTimeout === undefined) {
        throw new Error("idleTimeout is required when kind='idle'");
      }
      timeout = idleTimeout;
      message =
        `Node "${node}" exceeded its idle timeout of ${idleTimeout}ms ` +
        `without making progress (elapsed: ${elapsed}ms).`;
    } else {
      if (runTimeout === undefined) {
        throw new Error("runTimeout is required when kind='run'");
      }
      timeout = runTimeout;
      message =
        `Node "${node}" exceeded its run timeout of ${runTimeout}ms ` +
        `(elapsed: ${elapsed}ms).`;
    }
    super(message, errorFields);
    this.name = "NodeTimeoutError";
    this.node = node;
    this.kind = kind;
    this.timeout = timeout;
    this.elapsed = elapsed;
    this.runTimeout = runTimeout;
    this.idleTimeout = idleTimeout;
  }

  static get unminifiable_name() {
    return "NodeTimeoutError";
  }
}

export function isNodeTimeoutError(e?: unknown): e is NodeTimeoutError {
  return (
    e !== undefined &&
    (e as NodeTimeoutError).name === NodeTimeoutError.unminifiable_name
  );
}

export class EmptyInputError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "EmptyInputError";
  }

  static get unminifiable_name() {
    return "EmptyInputError";
  }
}

export class EmptyChannelError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    // Skip expensive stack trace capture — used for control flow on channel reads.
    const prevLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(message, fields);
    Error.stackTraceLimit = prevLimit;
    this.name = "EmptyChannelError";
  }

  static get unminifiable_name() {
    return "EmptyChannelError";
  }
}

export class InvalidUpdateError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "InvalidUpdateError";
  }

  static get unminifiable_name() {
    return "InvalidUpdateError";
  }
}

/**
 * @deprecated This exception type is no longer thrown.
 */
export class MultipleSubgraphsError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "MultipleSubgraphError";
  }

  static get unminifiable_name() {
    return "MultipleSubgraphError";
  }
}

export class UnreachableNodeError extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "UnreachableNodeError";
  }

  static get unminifiable_name() {
    return "UnreachableNodeError";
  }
}

/**
 * Exception raised when an error occurs in the remote graph.
 */
export class RemoteException extends BaseLangGraphError {
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "RemoteException";
  }

  static get unminifiable_name() {
    return "RemoteException";
  }
}

/**
 * Error thrown when invalid input is provided to a StateGraph.
 *
 * This typically means that the input to the StateGraph constructor or builder
 * did not match the required types. A valid input should be a
 * StateDefinition, an Annotation.Root, or a Zod schema.
 *
 * @example
 * // Example of incorrect usage:
 * try {
 *   new StateGraph({ foo: "bar" }); // Not a valid input
 * } catch (err) {
 *   if (err instanceof StateGraphInputError) {
 *     console.error(err.message);
 *   }
 * }
 */
export class StateGraphInputError extends BaseLangGraphError {
  /**
   * Create a new StateGraphInputError.
   * @param message - Optional custom error message.
   * @param fields - Optional additional error fields.
   */
  constructor(message?: string, fields?: BaseLangGraphErrorFields) {
    super(message, fields);
    this.name = "StateGraphInputError";
    this.message =
      "Invalid StateGraph input. Make sure to pass a valid StateDefinition, Annotation.Root, or Zod schema.";
  }

  /**
   * The unminifiable (static, human-readable) error name for this error class.
   */
  static get unminifiable_name() {
    return "StateGraphInputError";
  }
}

/**
 * Used for subgraph detection.
 */
export const getSubgraphsSeenSet = () => {
  if (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")] === undefined
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")] = new Set();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any)[Symbol.for("LG_CHECKPOINT_SEEN_NS_SET")];
};
