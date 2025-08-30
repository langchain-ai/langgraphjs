import { Command, Interrupt } from "./constants.js";

// When editing, make sure to update the index found here:
// https://langchain-ai.github.io/langgraphjs/troubleshooting/errors/
export type BaseLangGraphErrorFields = {
  lc_error_code?:
    | "GRAPH_RECURSION_LIMIT"
    | "INVALID_CONCURRENT_GRAPH_UPDATE"
    | "INVALID_GRAPH_NODE_RETURN_VALUE"
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
      finalMessage = `${finalMessage}\n\nTroubleshooting URL: https://langchain-ai.github.io/langgraphjs/troubleshooting/errors/${fields.lc_error_code}/\n`;
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
    super(message, fields);
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
